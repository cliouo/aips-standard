/**
 * Tests for the dispatcher middleware chain — §3, §6, §7, §14.
 */

import { describe, it, expect } from 'vitest';
import {
  ActionRegistry,
  RefractError,
  MemoryConfirmationStore,
  MemoryIdempotencyStore,
  MemoryLoopDetector,
  MemoryRateLimiter,
} from '../src/index.js';
import { echoAction, writeAction, makeCtx, CapturingAudit } from './helpers.js';

function freshRegistry() {
  return new ActionRegistry({
    idempotency: new MemoryIdempotencyStore(),
    confirmation: new MemoryConfirmationStore(),
    rateLimit: new MemoryRateLimiter(),
    loop: new MemoryLoopDetector(),
  }).register(echoAction, writeAction);
}

describe('Dispatcher — §6 confirmation flow', () => {
  it('first call without token returns PENDING_CONFIRMATION with summary', async () => {
    const r = freshRegistry();
    const ctx = makeCtx();
    await expect(
      r.dispatch('do_write', { value: 'hello' }, ctx),
    ).rejects.toMatchObject({
      code: 'PENDING_CONFIRMATION',
      extra: expect.objectContaining({
        summary: 'Will set value to "hello"',
        confirmation_token: expect.stringMatching(/^ct_/),
      }),
    });
  });

  it('replay with the token succeeds', async () => {
    const r = freshRegistry();
    const ctx1 = makeCtx({ idempotency_key: 'k1' });
    let token = '';
    try {
      await r.dispatch('do_write', { value: 'x' }, ctx1);
    } catch (e) {
      token = (e as RefractError).extra.confirmation_token as string;
    }
    expect(token).toMatch(/^ct_/);

    const ctx2 = makeCtx({
      idempotency_key: 'k2',
      confirmation_token: token,
    });
    const result = await r.dispatch('do_write', { value: 'x' }, ctx2);
    expect(result).toEqual({ id: 'id_x', value: 'x' });
  });

  it('rejects a token if input changed between issue and consume', async () => {
    const r = freshRegistry();
    let token = '';
    try {
      await r.dispatch('do_write', { value: 'a' }, makeCtx());
    } catch (e) {
      token = (e as RefractError).extra.confirmation_token as string;
    }
    await expect(
      r.dispatch(
        'do_write',
        { value: 'b' /* changed! */ },
        makeCtx({ confirmation_token: token }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects a token after one-shot consumption', async () => {
    const r = freshRegistry();
    let token = '';
    try {
      await r.dispatch('do_write', { value: 'x' }, makeCtx());
    } catch (e) {
      token = (e as RefractError).extra.confirmation_token as string;
    }
    await r.dispatch(
      'do_write',
      { value: 'x' },
      makeCtx({ confirmation_token: token, idempotency_key: 'k-first' }),
    );
    // Second use with same token should fail
    await expect(
      r.dispatch(
        'do_write',
        { value: 'x' },
        makeCtx({ confirmation_token: token, idempotency_key: 'k-second' }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('Dispatcher — §7 idempotency', () => {
  it('returns cached result for same idempotency_key on writes', async () => {
    const r = freshRegistry();
    let token = '';
    try {
      await r.dispatch('do_write', { value: 'x' }, makeCtx({ idempotency_key: 'kAA' }));
    } catch (e) {
      token = (e as RefractError).extra.confirmation_token as string;
    }
    const r1 = await r.dispatch(
      'do_write',
      { value: 'x' },
      makeCtx({ confirmation_token: token, idempotency_key: 'kAA' }),
    );
    // Replay with same idempotency key — should return cached result without re-running
    const r2 = await r.dispatch(
      'do_write',
      { value: 'x' },
      makeCtx({ idempotency_key: 'kAA' /* no token */ }),
    );
    expect(r1).toEqual(r2);
  });
});

describe('Dispatcher — §13 audit', () => {
  it('audits every executed action with delegation', async () => {
    const r = freshRegistry();
    const audit = new CapturingAudit();
    await r.dispatch('echo', { message: 'hi' }, makeCtx({ audit }));
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0].event).toBe('action_executed');
    expect(audit.events[0].data).toMatchObject({
      actor_user_id: 'u_test',
      action: { name: 'echo' },
      status: 'success',
      delegation: { via: 'ai_chat' },
    });
  });

  it('audits failures with error_code', async () => {
    const r = freshRegistry();
    const audit = new CapturingAudit();
    await expect(
      r.dispatch('echo', { /* missing required `message` */ }, makeCtx({ audit })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(audit.events[0].data).toMatchObject({
      status: 'error',
      error_code: 'INVALID_INPUT',
    });
  });
});

describe('Dispatcher — §14 loop detection', () => {
  it('blocks the 4th identical call within the window', async () => {
    const r = freshRegistry();
    const ctx = makeCtx();
    await r.dispatch('echo', { message: 'x' }, ctx);
    await r.dispatch('echo', { message: 'x' }, ctx);
    await r.dispatch('echo', { message: 'x' }, ctx);
    await expect(r.dispatch('echo', { message: 'x' }, ctx)).rejects.toMatchObject({
      code: 'LOOP_DETECTED',
    });
  });
});
