/**
 * Tests for AAT alignment — see STANDARD.md §13 and IETF
 * draft-sharif-agent-audit-trail.
 */

import { describe, it, expect } from 'vitest';
import {
  ActionRegistry,
  MemoryAuditStore,
  MemoryConfirmationStore,
  MemoryIdempotencyStore,
  MemoryLoopDetector,
  MemoryRateLimiter,
  AAT_ACTION_TYPES,
  AAT_OUTCOMES,
  AAT_TRUST_LEVELS,
  buildAATRecord,
  hashRecord,
  jcsCanonicalize,
  translateToAAT,
  verifyChain,
} from '../src/index.js';
import { echoAction, makeCtx } from './helpers.js';

const identity = { agent_id: 'urn:agent:test', agent_version: '0.0.1' as const };

describe('AAT primitives', () => {
  it('enum constants match the spec', () => {
    expect(AAT_ACTION_TYPES).toContain('tool_call');
    expect(AAT_ACTION_TYPES).toContain('lifecycle');
    expect(AAT_OUTCOMES).toContain('denied');
    expect(AAT_TRUST_LEVELS).toEqual(['L0', 'L1', 'L2', 'L3', 'L4']);
  });

  it('jcsCanonicalize sorts keys deterministically', () => {
    const a = jcsCanonicalize({ b: 1, a: 2, nested: { y: 1, x: 2 } });
    const b = jcsCanonicalize({ a: 2, b: 1, nested: { x: 2, y: 1 } });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"nested":{"x":2,"y":1}}');
  });

  it('buildAATRecord with no parent produces a genesis record', () => {
    const rec = buildAATRecord(
      { action_type: 'lifecycle', action_detail: { event: 'session_start' }, outcome: 'success' },
      { identity },
    );
    expect(rec.parent_record_id).toBeNull();
    expect(rec.prev_hash).toBeNull();
    expect(rec.agent_id).toBe('urn:agent:test');
    expect(rec.trust_level).toBe('L2');
    expect(rec.record_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('buildAATRecord with parent links via prev_hash', () => {
    const parent = buildAATRecord(
      { action_type: 'tool_call', action_detail: {}, outcome: 'success' },
      { identity },
    );
    const child = buildAATRecord(
      { action_type: 'tool_call', action_detail: {}, outcome: 'success' },
      { identity, parent },
    );
    expect(child.parent_record_id).toBe(parent.record_id);
    expect(child.prev_hash).toBe(hashRecord(parent));
    expect(child.prev_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('translateToAAT — legacy dispatcher payload → AAT', () => {
  it('maps a successful action_executed event', () => {
    const rec = translateToAAT(
      'action_executed',
      {
        actor_user_id: 'u1',
        action: { name: 'echo', version: '1.0' },
        status: 'success',
        duration_ms: 12,
        delegation: { via: 'ai_chat', llm_model: 'claude-opus-4-7' },
        input_hash: 'abc123',
      },
      { identity },
    );
    expect(rec.action_type).toBe('tool_call');
    expect(rec.outcome).toBe('success');
    expect(rec.action_detail.tool_name).toBe('echo');
    expect((rec.action_detail.actor as any).user_id).toBe('u1');
    expect(rec.latency_ms).toBe(12);
    expect(rec.model_id).toBe('claude-opus-4-7');
    expect(rec.input_hash).toBe('abc123');
  });

  it('maps never_list_blocked to denied outcome', () => {
    const rec = translateToAAT(
      'never_list_blocked',
      {
        actor_user_id: 'u_attacker',
        action: { name: 'delete_tenant' },
        reason: 'never-list hit',
      },
      { identity },
    );
    expect(rec.outcome).toBe('denied');
  });

  it('maps PERMISSION_DENIED error_code to denied', () => {
    const rec = translateToAAT(
      'action_executed',
      { status: 'error', error_code: 'PERMISSION_DENIED' },
      { identity },
    );
    expect(rec.outcome).toBe('denied');
  });
});

describe('MemoryAuditStore — AAT-backed', () => {
  it('produces a valid hash chain across multiple events', async () => {
    const audit = new MemoryAuditStore({ identity, echoToConsole: false });
    const registry = new ActionRegistry({
      idempotency: new MemoryIdempotencyStore(),
      confirmation: new MemoryConfirmationStore(),
      rateLimit: new MemoryRateLimiter(),
      loop: new MemoryLoopDetector(),
    }).register(echoAction);

    for (let i = 0; i < 5; i++) {
      await registry.dispatch('echo', { message: `m${i}` }, makeCtx({ audit }));
    }

    const broken = await audit.verifyChain();
    expect(broken).toBe(-1);

    const raw = audit.rawAAT();
    expect(raw[0].prev_hash).toBeNull();
    expect(raw[0].parent_record_id).toBeNull();
    for (let i = 1; i < raw.length; i++) {
      expect(raw[i].parent_record_id).toBe(raw[i - 1].record_id);
    }
  });

  it('verifyChain detects tampering', async () => {
    const audit = new MemoryAuditStore({ identity, echoToConsole: false });
    const registry = new ActionRegistry({
      idempotency: new MemoryIdempotencyStore(),
      confirmation: new MemoryConfirmationStore(),
      rateLimit: new MemoryRateLimiter(),
      loop: new MemoryLoopDetector(),
    }).register(echoAction);

    await registry.dispatch('echo', { message: 'a' }, makeCtx({ audit }));
    await registry.dispatch('echo', { message: 'b' }, makeCtx({ audit }));
    await registry.dispatch('echo', { message: 'c' }, makeCtx({ audit }));

    // Tamper: replace the second record's action_detail
    const raw = audit.rawAAT() as any[];
    raw[1].action_detail = { tampered: true };

    expect(await audit.verifyChain()).toBe(2); // index where chain breaks
  });

  it('records include Refract extension fields', async () => {
    const audit = new MemoryAuditStore({ identity, echoToConsole: false });
    const registry = new ActionRegistry({
      idempotency: new MemoryIdempotencyStore(),
      confirmation: new MemoryConfirmationStore(),
      rateLimit: new MemoryRateLimiter(),
      loop: new MemoryLoopDetector(),
    }).register(echoAction);

    await registry.dispatch('echo', { message: 'x' }, makeCtx({ audit }));
    const raw = audit.rawAAT();
    expect(raw[0].refract_trace_id).toBe('trace_test');
  });

  it('signer hook produces a signature field', async () => {
    const audit = new MemoryAuditStore({
      identity,
      echoToConsole: false,
      signer: (bytes) => 'sig:' + bytes.length,
    });
    const registry = new ActionRegistry({
      idempotency: new MemoryIdempotencyStore(),
      confirmation: new MemoryConfirmationStore(),
      rateLimit: new MemoryRateLimiter(),
      loop: new MemoryLoopDetector(),
    }).register(echoAction);

    await registry.dispatch('echo', { message: 'x' }, makeCtx({ audit }));
    expect(audit.rawAAT()[0].signature).toMatch(/^sig:\d+$/);
  });
});
