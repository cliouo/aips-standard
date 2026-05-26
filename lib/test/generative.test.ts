/**
 * §24 — Execution shapes: kind + output provenance on Generative Actions.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineAction, createRestHandler } from '../src/index.js';
import { makeRegistry, makeCtx, CapturingAudit } from './helpers.js';

const base = {
  version: '1.0',
  description: 'desc',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  async handler() {
    return { ok: true };
  },
};

describe('§24 execution shape — kind & provenance', () => {
  it('defaults deterministic actions to kind=deterministic / provenance=retrieved', () => {
    const a = defineAction({ ...base, name: 'read_thing', risk: 'read' });
    expect(a.spec.kind).toBe('deterministic');
    expect(a.spec.provenance).toBe('retrieved');
  });

  it('defaults generative actions to provenance=generated', () => {
    const a = defineAction({ ...base, name: 'gen_thing', risk: 'read', kind: 'generative' });
    expect(a.spec.kind).toBe('generative');
    expect(a.spec.provenance).toBe('generated');
  });

  it('preserves an explicit provenance of mixed', () => {
    const a = defineAction({
      ...base,
      name: 'gen_mixed',
      risk: 'read',
      kind: 'generative',
      provenance: 'mixed',
    });
    expect(a.spec.provenance).toBe('mixed');
  });

  it('rejects a non-generative action claiming provenance=generated', () => {
    expect(() =>
      defineAction({ ...base, name: 'mislabel', risk: 'read', provenance: 'generated' }),
    ).toThrow(/not generative/);
  });

  it('records kind + provenance in the audit log (§13/§24)', async () => {
    const registry = makeRegistry();
    registry.register(
      defineAction({ ...base, name: 'gen_audit', risk: 'read', kind: 'generative' }),
    );
    const audit = new CapturingAudit();
    await registry.dispatch('gen_audit', {}, makeCtx({ audit }));
    const rec = audit.events.find((e) => e.event === 'action_executed');
    expect(rec?.data.kind).toBe('generative');
    expect(rec?.data.provenance).toBe('generated');
  });

  it('surfaces provenance on the REST X-Refract-Provenance header (§24)', async () => {
    const registry = makeRegistry();
    registry.register(
      defineAction({ ...base, name: 'gen_http', risk: 'read', kind: 'generative' }),
    );
    const handle = createRestHandler(registry, (req) =>
      makeCtx({ delegation: req.delegation, trace_id: req.trace_id }),
    );
    const res = await handle({
      actionName: 'gen_http',
      body: {},
      headers: {},
      user_id: 'u_test',
      user_roles: ['member'],
    });
    expect(res.status).toBe(200);
    expect(res.headers?.['X-Refract-Provenance']).toBe('generated');
  });
});
