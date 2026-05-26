/**
 * Dispatcher — runs the middleware chain around an Action handler.
 *
 * Chain order is fixed by STANDARD.md §3:
 *   never-list → input-validate → idempotency → loop → rate-limit
 *   → confirmation → handler → audit → idempotency-cache → redact
 *
 * §13 mandates that *every* attempt is audited, including ones rejected
 * by middleware. We use a try/finally so even early failures get a
 * record written.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import type { Action, Context } from './types.js';
import { RefractError, errors } from './errors.js';
import type {
  ConfirmationStore,
  IdempotencyStore,
  LoopDetector,
  RateLimiter,
} from './stores.js';
import type { Redactor } from './redaction.js';
import type { PlanCoordinator } from './plan.js';

export interface DispatcherDeps {
  idempotency: IdempotencyStore;
  confirmation: ConfirmationStore;
  rateLimit: RateLimiter;
  loop: LoopDetector;
  /** §11 — applied to handler output before return; default = identity */
  redact?: Redactor;
  /** §12 — see never-list.ts; default = empty list */
  neverList?: import('./never-list.js').NeverList;
  /** §17 — when set, plan-covered calls skip confirmation */
  plans?: PlanCoordinator;
}

function canonicalize(input: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(sortKeys);
    const obj = v as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys(obj[k]);
        return acc;
      }, {});
  };
  return JSON.stringify(sortKeys(input));
}

function hashInput(input: unknown): string {
  return crypto.createHash('sha256').update(canonicalize(input)).digest('hex');
}

export async function dispatch(
  action: Action,
  rawInput: unknown,
  ctx: Context,
  deps: DispatcherDeps,
): Promise<unknown> {
  const { spec } = action;
  const startedAt = Date.now();

  // State shared between pipeline body and the finally block
  let inputHash: string | null = null;
  let thrown: unknown = undefined;
  let result: unknown = undefined;
  let succeeded = false;

  try {
    // §12 — dispatch-time never-list guard (defense in depth)
    if (deps.neverList && ctx.delegation.via !== 'direct') {
      const hit = deps.neverList.check(spec.name);
      if (hit) {
        // Separate explicit audit record for visibility
        await ctx.audit.log('never_list_blocked', {
          trace_id: ctx.trace_id,
          actor_user_id: ctx.user.id,
          action: spec.name,
          delegation: ctx.delegation,
          reason: hit.reason,
        });
        throw errors.neverAllowed(spec.name);
      }
    }

    // §15 — refuse removed actions
    if (spec.removedAt && new Date(spec.removedAt) <= new Date()) {
      throw errors.notFound(`Action ${spec.name} was removed on ${spec.removedAt}`);
    }

    // 1. Input validation (§8 INVALID_INPUT)
    let input: unknown;
    try {
      input = spec.input.parse(rawInput);
    } catch (e) {
      if (e instanceof z.ZodError) {
        const issue = e.issues[0];
        throw errors.invalidInput(
          issue.message,
          issue.path.join('.') || undefined,
        );
      }
      throw e;
    }
    inputHash = hashInput(input);

    // 2. Idempotency check (§7) — writes only
    const idempotencyKey =
      spec.risk !== 'read' && ctx.idempotency_key
        ? `${ctx.user.id}:${spec.name}:${ctx.idempotency_key}`
        : null;

    if (idempotencyKey) {
      const cached = await deps.idempotency.get(idempotencyKey);
      if (cached) {
        if (cached.error) throw rehydrateError(cached.error);
        result = cached.result;
        succeeded = true;
        return deps.redact ? deps.redact(result, ctx) : result;
      }
    }

    // 3. Loop detection (§14)
    await deps.loop.check(ctx.user.id, spec.name, inputHash);

    // 4. Rate limit (§14)
    if (spec.rateLimit) {
      const rl = await deps.rateLimit.check(ctx.user.id, spec.name, spec.rateLimit);
      if (!rl.allowed) {
        throw errors.rateLimited(rl.retry_after ?? 60);
      }
    }

    // 5. Confirmation (§6) — §17 plan-covered steps skip it
    const activePlanId = (ctx as any).__active_plan_id as string | undefined;
    const coveredByPlan =
      deps.plans && activePlanId
        ? deps.plans.coversCall(activePlanId, spec.name, input as Record<string, unknown>)
        : false;

    if (spec.requiresConfirmation && !coveredByPlan) {
      if (!ctx.confirmation_token) {
        const ttlSec = 300;
        const token = await deps.confirmation.issue(
          ctx.user.id,
          spec.name,
          inputHash,
          ttlSec,
        );
        const summary = spec.summary
          ? (spec.summary as (i: unknown) => string)(input)
          : `Will execute ${spec.name}`;
        throw errors.pendingConfirmation(
          token,
          summary,
          new Date(Date.now() + ttlSec * 1000).toISOString(),
        );
      } else {
        const ok = await deps.confirmation.consume(
          ctx.user.id,
          spec.name,
          inputHash,
          ctx.confirmation_token,
        );
        if (!ok) {
          throw errors.invalidInput(
            'Confirmation token invalid, expired, or parameters changed',
          );
        }
      }
    }

    // 6. Handler
    try {
      result = await (spec.handler as (c: Context, i: unknown) => Promise<unknown>)(
        ctx,
        input,
      );
      spec.output.parse(result);
      succeeded = true;
    } catch (e) {
      thrown = normalizeError(e);
    }

    // 7. Cache idempotency result (success or business-level error)
    if (idempotencyKey) {
      await deps.idempotency.set(
        idempotencyKey,
        thrown ? { error: serializeError(thrown) } : { result },
        24 * 60 * 60,
      );
    }

    if (thrown) throw thrown;

    // §11 — redact output based on caller's roles
    return deps.redact ? deps.redact(result, ctx) : result;
  } catch (e) {
    if (!thrown) thrown = e;
    throw e;
  } finally {
    // §13 — always audit
    await ctx.audit.log('action_executed', {
      trace_id: ctx.trace_id,
      actor_user_id: ctx.user.id,
      delegation: ctx.delegation,
      action: { name: spec.name, version: spec.version },
      // §24 — execution shape + output provenance
      kind: spec.kind ?? 'deterministic',
      provenance: spec.provenance ?? 'retrieved',
      input_hash: inputHash,
      status: succeeded ? 'success' : 'error',
      error_code:
        thrown instanceof RefractError
          ? thrown.code
          : thrown
            ? 'INTERNAL_ERROR'
            : null,
      duration_ms: Date.now() - startedAt,
      confirmation: ctx.confirmation_token
        ? { token: ctx.confirmation_token, confirmed_at: new Date().toISOString() }
        : null,
      // §21-B — full payload for undo / detail view.
      // Production: encrypt or move to a separate store if your audit
      // log isn't appropriate for raw PII (combine with §22 redaction).
      input_snapshot: succeeded ? rawInput : null,
      output_snapshot: succeeded ? result : null,
      // Undoability flag for the activity history UI
      undoable: succeeded && typeof spec.undo === 'function',
    });
  }
}

function normalizeError(e: unknown): RefractError {
  if (e instanceof RefractError) return e;
  if (e instanceof Error) return errors.internalError(e.message);
  return errors.internalError(String(e));
}

function serializeError(e: unknown): Record<string, unknown> {
  if (e instanceof RefractError) {
    return { ...e.toJSON(), httpStatus: e.httpStatus };
  }
  return errors.internalError(String(e)).toJSON();
}

function rehydrateError(data: Record<string, unknown>): RefractError {
  return new RefractError(
    String(data.error),
    String(data.message_for_user),
    String(data.message_for_ai),
    Number(data.httpStatus ?? 500),
    Boolean(data.retryable),
  );
}
