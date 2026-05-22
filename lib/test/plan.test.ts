/**
 * Tests for §17 Plan & Checkpoint state machine.
 */

import { describe, it, expect } from 'vitest';
import {
  ActionRegistry,
  PlanCoordinator,
  MemoryConfirmationStore,
  MemoryIdempotencyStore,
  MemoryLoopDetector,
  MemoryRateLimiter,
  type CheckpointEvent,
} from '../src/index.js';
import { echoAction, writeAction, makeCtx } from './helpers.js';

function setup() {
  const plans = new PlanCoordinator();
  const r = new ActionRegistry({
    idempotency: new MemoryIdempotencyStore(),
    confirmation: new MemoryConfirmationStore(),
    rateLimit: new MemoryRateLimiter(),
    loop: new MemoryLoopDetector(),
    plans,
  }).register(echoAction, writeAction);
  return { plans, r };
}

describe('§17 Plan state machine', () => {
  it('rejects approve on unknown plan', () => {
    const { plans } = setup();
    expect(() => plans.approve('plan_nope', 'u_test')).toThrow(/not found|NOT_FOUND/i);
  });

  it('rejects approve from wrong user', () => {
    const { plans } = setup();
    const plan = plans.propose('u_owner', [], 's');
    expect(() => plans.approve(plan.id, 'u_other')).toThrow(
      /permission|PERMISSION/i,
    );
  });

  it('rejects double-approve', () => {
    const { plans } = setup();
    const plan = plans.propose('u_test', [], 's');
    plans.approve(plan.id, 'u_test');
    expect(() => plans.approve(plan.id, 'u_test')).toThrow(/approved/);
  });

  it('skips per-step confirmation for plan-covered write steps', async () => {
    const { plans, r } = setup();
    const plan = plans.propose(
      'u_test',
      [{ action: 'do_write', input: { value: 'hello' } }],
      'will write once',
    );
    plans.approve(plan.id, 'u_test');

    const events: CheckpointEvent[] = [];
    await plans.execute(plan.id, r, makeCtx({ user: { id: 'u_test', roles: [] } }), (e) =>
      events.push(e),
    );
    expect(events.map((e) => e.type)).toEqual([
      'step_started',
      'step_completed',
      'plan_completed',
    ]);
    const completed = events.find((e) => e.type === 'step_completed') as any;
    expect(completed.result).toEqual({ id: 'id_hello', value: 'hello' });
  });

  it('still requires confirmation for steps in dangerousActions', async () => {
    const { plans, r } = setup();
    const plan = plans.propose(
      'u_test',
      [{ action: 'do_write', input: { value: 'hello' } }],
      's',
      { dangerousActions: ['do_write'] },
    );
    plans.approve(plan.id, 'u_test');

    const events: CheckpointEvent[] = [];
    await plans.execute(plan.id, r, makeCtx({ user: { id: 'u_test', roles: [] } }), (e) =>
      events.push(e),
    );
    const failed = events.find((e) => e.type === 'step_failed') as any;
    expect(failed?.error?.error).toBe('PENDING_CONFIRMATION');
  });

  it('honors interrupt between steps', async () => {
    const { plans, r } = setup();
    const plan = plans.propose(
      'u_test',
      [
        { action: 'echo', input: { message: 'one' } },
        { action: 'echo', input: { message: 'two' } },
        { action: 'echo', input: { message: 'three' } },
      ],
      's',
    );
    plans.approve(plan.id, 'u_test');

    const events: CheckpointEvent[] = [];
    const handler = async (e: CheckpointEvent) => {
      events.push(e);
      if (e.type === 'step_completed' && e.index === 0) {
        plans.requestInterrupt(plan.id);
      }
    };
    await plans.execute(plan.id, r, makeCtx({ user: { id: 'u_test', roles: [] } }), handler);
    const types = events.map((e) => e.type);
    expect(types).toContain('plan_aborted');
    expect(types.filter((t) => t === 'step_started').length).toBe(1);
  });
});
