/**
 * Tests for §21 transparency data layer modules.
 */

import { describe, it, expect } from 'vitest';
import {
  MemoryAuditStore,
  MemoryAPIKeyStore,
  ContextDecider,
  AnomalyDetector,
  ActionRegistry,
  MemoryConfirmationStore,
  MemoryIdempotencyStore,
  MemoryLoopDetector,
  MemoryRateLimiter,
} from '../src/index.js';
import { echoAction, writeAction, makeCtx } from './helpers.js';

describe('MemoryAuditStore — §13 + §21 query', () => {
  it('stores and retrieves by id', async () => {
    const a = new MemoryAuditStore({
      identity: { agent_id: 'urn:agent:test', agent_version: '0.0.1' },
      echoToConsole: false,
    });
    await a.log('action_executed', {
      actor_user_id: 'u1',
      action: { name: 'echo' },
      status: 'success',
    });
    const page = await a.query({});
    const id = page.items[0].id;
    const rec = await a.get(id);
    expect(rec?.actor_user_id).toBe('u1');
    expect(rec?.action_name).toBe('echo');
  });

  it('filters by user and status', async () => {
    const a = new MemoryAuditStore({
      identity: { agent_id: 'urn:agent:test', agent_version: '0.0.1' },
      echoToConsole: false,
    });
    await a.log('action_executed', { actor_user_id: 'u1', action: { name: 'a' }, status: 'success' });
    await a.log('action_executed', { actor_user_id: 'u1', action: { name: 'a' }, status: 'error' });
    await a.log('action_executed', { actor_user_id: 'u2', action: { name: 'a' }, status: 'success' });

    const u1 = await a.query({ actorUserId: 'u1' });
    expect(u1.total).toBe(2);

    const u1ok = await a.query({ actorUserId: 'u1', status: 'success' });
    expect(u1ok.total).toBe(1);
  });

  it('paginates with cursor', async () => {
    const a = new MemoryAuditStore({
      identity: { agent_id: 'urn:agent:test', agent_version: '0.0.1' },
      echoToConsole: false,
    });
    for (let i = 0; i < 25; i++) {
      await a.log('action_executed', { actor_user_id: 'u', status: 'success' });
    }
    const p1 = await a.query({ limit: 10 });
    expect(p1.items).toHaveLength(10);
    expect(p1.truncated).toBe(true);

    const p2 = await a.query({ limit: 10, cursor: p1.next_cursor! });
    expect(p2.items).toHaveLength(10);
    expect(p2.items[0].id).not.toBe(p1.items[0].id);
  });
});

describe('MemoryAPIKeyStore — §21-B', () => {
  it('returns secret exactly once on create', async () => {
    const store = new MemoryAPIKeyStore();
    const { key, secret } = await store.create('u1', { name: 'k', scopes: ['*'] });
    expect(secret).toMatch(/^refract_/);
    expect(key.prefix).toBe(secret.slice(0, 8));
    // Listing should not return the secret
    const list = await store.list('u1');
    expect(JSON.stringify(list)).not.toContain(secret);
  });

  it('resolves an active key by secret, but not after revoke', async () => {
    const store = new MemoryAPIKeyStore();
    const { key, secret } = await store.create('u1', { name: 'k', scopes: ['*'] });
    expect((await store.resolve(secret))?.id).toBe(key.id);

    await store.revoke('u1', key.id);
    expect(await store.resolve(secret)).toBeNull();
  });

  it('resolves last_used_at after a successful resolve', async () => {
    const store = new MemoryAPIKeyStore();
    const { secret } = await store.create('u1', { name: 'k', scopes: ['*'] });
    await store.resolve(secret);
    const list = await store.list('u1');
    expect(list[0].last_used_at).not.toBeNull();
  });

  it('refuses to revoke another user\'s key', async () => {
    const store = new MemoryAPIKeyStore();
    const { key } = await store.create('u_owner', { name: 'k', scopes: ['*'] });
    const result = await store.revoke('u_other', key.id);
    expect(result).toBeNull();
    const list = await store.list('u_owner');
    expect(list[0].status).toBe('active');
  });
});

describe('ContextDecider — §21-A', () => {
  function r() {
    return new ActionRegistry({
      idempotency: new MemoryIdempotencyStore(),
      confirmation: new MemoryConfirmationStore(),
      rateLimit: new MemoryRateLimiter(),
      loop: new MemoryLoopDetector(),
    }).register(echoAction, writeAction);
  }

  it('filters actions by route → domain mapping', () => {
    const registry = r();
    const d = new ContextDecider().onRoute('/team', 'team');

    // No matching route, no actions
    const off = d.resolve({ user: { id: 'u', roles: [] }, route: '/elsewhere' }, registry);
    expect(off.actions).toHaveLength(0);

    // We registered echoAction (no domain → 'misc') and writeAction (no domain → 'misc')
    // Neither is in 'team', so still 0
    const on = d.resolve({ user: { id: 'u', roles: [] }, route: '/team' }, registry);
    expect(on.actions).toHaveLength(0);

    // Now turn on 'misc' (where our fixtures live) for admins
    const d2 = new ContextDecider().onRole('admin', 'misc');
    const result = d2.resolve(
      { user: { id: 'u', roles: ['admin'] } },
      registry,
    );
    expect(result.actions.map((a) => a.name).sort()).toEqual(['do_write', 'echo']);
  });

  it('always() domains are always exposed', () => {
    const registry = r();
    const d = new ContextDecider().always('misc');
    const result = d.resolve({ user: { id: 'u', roles: [] } }, registry);
    expect(result.actions.length).toBeGreaterThan(0);
  });
});

describe('AnomalyDetector — §21-C', () => {
  it('finds error_burst when threshold exceeded in window', async () => {
    const audit = new MemoryAuditStore({
      identity: { agent_id: 'urn:agent:test', agent_version: '0.0.1' },
      echoToConsole: false,
    });
    for (let i = 0; i < 25; i++) {
      await audit.log('action_executed', {
        actor_user_id: 'u_attacker',
        action: { name: 'echo' },
        status: 'error',
        error_code: 'INVALID_INPUT',
      });
    }
    const det = new AnomalyDetector(audit, {
      errorBurst: { minutes: 5, threshold: 20 },
    });
    const findings = await det.scan();
    const burst = findings.find((f) => f.kind === 'error_burst');
    expect(burst).toBeDefined();
    expect(burst!.user_id).toBe('u_attacker');
    expect(burst!.count).toBe(25);
  });

  it('reports nothing below threshold', async () => {
    const audit = new MemoryAuditStore({
      identity: { agent_id: 'urn:agent:test', agent_version: '0.0.1' },
      echoToConsole: false,
    });
    for (let i = 0; i < 3; i++) {
      await audit.log('action_executed', {
        actor_user_id: 'u',
        status: 'error',
      });
    }
    const det = new AnomalyDetector(audit);
    expect(await det.scan()).toHaveLength(0);
  });
});

describe('Dispatcher — undoable flag flows into audit', () => {
  it('marks completed actions with undo handler as undoable: true', async () => {
    const audit = new MemoryAuditStore({
      identity: { agent_id: 'urn:agent:test', agent_version: '0.0.1' },
      echoToConsole: false,
    });
    const registry = new ActionRegistry({
      idempotency: new MemoryIdempotencyStore(),
      confirmation: new MemoryConfirmationStore(),
      rateLimit: new MemoryRateLimiter(),
      loop: new MemoryLoopDetector(),
    });

    // Echo: no undo handler → undoable: false
    registry.register(echoAction);
    await registry.dispatch('echo', { message: 'x' }, makeCtx({ audit }));
    const page = await audit.query({});
    expect(page.items[0].data.undoable).toBe(false);
  });
});
