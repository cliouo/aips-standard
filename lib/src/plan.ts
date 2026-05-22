/**
 * Plans & Checkpoints — see STANDARD.md §17
 *
 * For complex tasks the AI proposes a plan first. The user approves the
 * whole plan once; per-step confirmations are skipped *unless* a step
 * deviates from the approved plan or is high risk.
 *
 * Lifecycle:
 *
 *    propose(steps)  →  PlanProposed event
 *                       (user reviews summary)
 *    approve(planId) →  PlanApproved
 *    execute()       →  per-step Checkpoint events
 *                       (user can interrupt)
 *    done | aborted  →  terminal
 *
 * The dispatcher consults the active plan during dispatch: if the
 * incoming action call is part of the plan, it bypasses the §6
 * confirmation prompt; if it deviates, normal confirmation applies.
 */

import crypto from 'node:crypto';
import type { Context } from './types.js';
import type { ActionRegistry } from './registry.js';
import { RefractError, errors } from './errors.js';

export interface PlanStep {
  action: string;
  input: Record<string, unknown>;
  /** Optional human-readable label for the checkpoint UI */
  label?: string;
}

export interface ProposedPlan {
  id: string;
  user_id: string;
  steps: PlanStep[];
  /** Plan-level summary shown to user once instead of N confirmations */
  summary: string;
  /** Action names that, if encountered, MUST re-prompt even within plan */
  dangerousActions?: string[];
  expiresAt: number;
}

export type CheckpointEvent =
  | { type: 'plan_proposed'; plan: ProposedPlan }
  | { type: 'plan_approved'; plan_id: string }
  | { type: 'plan_aborted'; plan_id: string; reason: string }
  | { type: 'step_started'; plan_id: string; index: number; step: PlanStep }
  | { type: 'step_completed'; plan_id: string; index: number; result: unknown }
  | { type: 'step_failed'; plan_id: string; index: number; error: unknown }
  | { type: 'plan_completed'; plan_id: string };

export type CheckpointHandler = (event: CheckpointEvent) => void | Promise<void>;

/**
 * In-memory plan store.
 *
 * State machine:
 *   proposed → approved → running → (completed | aborted)
 *                       ↘ aborted
 *   proposed → aborted
 */
export class PlanCoordinator {
  private plans = new Map<
    string,
    {
      plan: ProposedPlan;
      status: 'proposed' | 'approved' | 'running' | 'completed' | 'aborted';
      currentStep: number;
      interruptRequested: boolean;
    }
  >();

  propose(
    userId: string,
    steps: PlanStep[],
    summary: string,
    opts: { dangerousActions?: string[]; ttlSec?: number } = {},
  ): ProposedPlan {
    const id = 'plan_' + crypto.randomBytes(8).toString('hex');
    const plan: ProposedPlan = {
      id,
      user_id: userId,
      steps,
      summary,
      dangerousActions: opts.dangerousActions,
      expiresAt: Date.now() + (opts.ttlSec ?? 600) * 1000,
    };
    this.plans.set(id, {
      plan,
      status: 'proposed',
      currentStep: -1,
      interruptRequested: false,
    });
    return plan;
  }

  approve(planId: string, userId: string): void {
    const entry = this.plans.get(planId);
    if (!entry) throw errors.notFound(`Plan ${planId}`);
    if (entry.plan.user_id !== userId) throw errors.permissionDenied();
    if (entry.status !== 'proposed') {
      throw errors.conflict(`Plan is ${entry.status}, cannot approve`);
    }
    if (entry.plan.expiresAt < Date.now()) {
      throw errors.conflict('Plan expired');
    }
    entry.status = 'approved';
  }

  abort(planId: string, reason: string): void {
    const entry = this.plans.get(planId);
    if (!entry) return;
    if (entry.status === 'completed' || entry.status === 'aborted') return;
    entry.status = 'aborted';
    entry.interruptRequested = true;
  }

  requestInterrupt(planId: string): void {
    const entry = this.plans.get(planId);
    if (entry) entry.interruptRequested = true;
  }

  /**
   * Check if a given action call is part of an approved plan and may
   * skip §6 confirmation. Returns true if covered, false otherwise.
   */
  coversCall(planId: string, action: string, input: Record<string, unknown>): boolean {
    const entry = this.plans.get(planId);
    if (!entry || entry.status !== 'running') return false;
    if (entry.plan.dangerousActions?.includes(action)) return false; // re-confirm
    const expected = entry.plan.steps[entry.currentStep];
    if (!expected) return false;
    if (expected.action !== action) return false;
    return JSON.stringify(sortKeys(expected.input)) === JSON.stringify(sortKeys(input));
  }

  /**
   * Execute an approved plan through the registry. Emits checkpoint
   * events at every transition.
   */
  async execute(
    planId: string,
    registry: ActionRegistry,
    ctx: Context,
    onEvent: CheckpointHandler,
  ): Promise<void> {
    const entry = this.plans.get(planId);
    if (!entry) throw errors.notFound(`Plan ${planId}`);
    if (entry.status !== 'approved') {
      throw errors.conflict(`Plan must be approved before execute (is ${entry.status})`);
    }
    entry.status = 'running';

    for (let i = 0; i < entry.plan.steps.length; i++) {
      if (entry.interruptRequested) {
        entry.status = 'aborted';
        await onEvent({ type: 'plan_aborted', plan_id: planId, reason: 'user_interrupt' });
        return;
      }

      entry.currentStep = i;
      const step = entry.plan.steps[i];
      await onEvent({ type: 'step_started', plan_id: planId, index: i, step });

      try {
        // Mark this dispatch as plan-driven so the dispatcher can skip
        // confirmation prompts for non-dangerous steps.
        const planCtx: Context = {
          ...ctx,
          // Encode plan_id in idempotency key so re-execution is safe
          idempotency_key: `${planId}:${i}`,
        };
        (planCtx as any).__active_plan_id = planId;

        const result = await registry.dispatch(step.action, step.input, planCtx);
        await onEvent({ type: 'step_completed', plan_id: planId, index: i, result });
      } catch (e) {
        await onEvent({ type: 'step_failed', plan_id: planId, index: i, error: serialize(e) });
        entry.status = 'aborted';
        await onEvent({ type: 'plan_aborted', plan_id: planId, reason: 'step_failed' });
        return;
      }
    }

    entry.status = 'completed';
    await onEvent({ type: 'plan_completed', plan_id: planId });
  }

  get(planId: string): ProposedPlan | undefined {
    return this.plans.get(planId)?.plan;
  }
}

function sortKeys(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortKeys);
  const obj = v as Record<string, unknown>;
  return Object.keys(obj).sort().reduce<Record<string, unknown>>((acc, k) => {
    acc[k] = sortKeys(obj[k]);
    return acc;
  }, {});
}

function serialize(e: unknown): Record<string, unknown> {
  if (e instanceof RefractError) return e.toJSON();
  if (e instanceof Error) return { error: 'INTERNAL_ERROR', message: e.message };
  return { error: 'INTERNAL_ERROR', message: String(e) };
}
