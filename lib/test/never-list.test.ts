/**
 * Tests for §12 Never-List — two layers of defense.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  ActionRegistry,
  MemoryConfirmationStore,
  MemoryIdempotencyStore,
  MemoryLoopDetector,
  MemoryRateLimiter,
  NeverList,
  defineAction,
} from '../src/index.js';
import { makeCtx } from './helpers.js';

const forbidden = defineAction({
  name: 'delete_tenant',
  version: '1.0',
  description: 'should never register',
  risk: 'dangerous',
  requiresConfirmation: true,
  summary: () => 'will delete tenant',
  input: z.object({}),
  output: z.object({}),
  async handler() {
    return {};
  },
});

describe('§12 Never-List — registration-time lint', () => {
  it('rejects registering an AI-invocable forbidden action', () => {
    const neverList = new NeverList().add({
      pattern: /^delete_tenant/,
      reason: 'test',
    });
    const r = new ActionRegistry({
      idempotency: new MemoryIdempotencyStore(),
      confirmation: new MemoryConfirmationStore(),
      rateLimit: new MemoryRateLimiter(),
      loop: new MemoryLoopDetector(),
      neverList,
    });
    expect(() => r.register(forbidden)).toThrow(/never-list/);
  });

  it('allows registering if action is marked aiInvocable: false', () => {
    const neverList = new NeverList().add({
      pattern: /^delete_tenant/,
      reason: 'test',
    });
    const r = new ActionRegistry({
      idempotency: new MemoryIdempotencyStore(),
      confirmation: new MemoryConfirmationStore(),
      rateLimit: new MemoryRateLimiter(),
      loop: new MemoryLoopDetector(),
      neverList,
    });
    const internal = defineAction({
      name: 'delete_tenant',
      version: '1.0',
      description: 'internal only',
      risk: 'dangerous',
      requiresConfirmation: true,
      aiInvocable: false,
      summary: () => 'x',
      input: z.object({}),
      output: z.object({}),
      async handler() {
        return {};
      },
    });
    expect(() => r.register(internal)).not.toThrow();
  });
});

describe('§12 Never-List — dispatch-time guard', () => {
  it('blocks dispatch via AI delegation even if action somehow registered', async () => {
    // Simulate: action registered before never-list added (defense in depth)
    const neverList = new NeverList();
    const r = new ActionRegistry({
      idempotency: new MemoryIdempotencyStore(),
      confirmation: new MemoryConfirmationStore(),
      rateLimit: new MemoryRateLimiter(),
      loop: new MemoryLoopDetector(),
      neverList,
    });
    r.register(forbidden);
    // Now add to list
    neverList.add({ pattern: /^delete_tenant/, reason: 'after-the-fact lock' });

    await expect(
      r.dispatch('delete_tenant', {}, makeCtx({ delegation: { via: 'ai_chat' } })),
    ).rejects.toMatchObject({ code: 'NEVER_ALLOWED' });
  });

  it('allows dispatch via direct delegation (e.g. internal admin tool)', async () => {
    const neverList = new NeverList().add({
      pattern: /^delete_tenant/,
      reason: 'lock',
    });
    const r = new ActionRegistry({
      idempotency: new MemoryIdempotencyStore(),
      confirmation: new MemoryConfirmationStore(),
      rateLimit: new MemoryRateLimiter(),
      loop: new MemoryLoopDetector(),
      neverList,
    });
    // Register an aiInvocable: false action — registration passes the lint
    const internal = defineAction({
      name: 'delete_tenant',
      version: '1.0',
      description: 'internal',
      risk: 'dangerous',
      requiresConfirmation: true,
      aiInvocable: false,
      summary: () => 'x',
      input: z.object({}),
      output: z.object({}),
      async handler() {
        return { ok: true };
      },
    });
    r.register(internal);

    // Direct (non-AI) dispatch bypasses the never-list guard
    let token = '';
    try {
      await r.dispatch('delete_tenant', {}, makeCtx({ delegation: { via: 'direct' } }));
    } catch (e: any) {
      token = e.extra?.confirmation_token;
    }
    expect(token).toMatch(/^ct_/);
  });
});
