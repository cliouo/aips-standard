/**
 * Tests for §4 spec validation in defineAction().
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineAction } from '../src/index.js';

const baseSpec = {
  name: 'do_thing',
  version: '1.0',
  description: 'desc',
  input: z.object({}),
  output: z.object({}),
  async handler() {
    return {};
  },
};

describe('defineAction — §4 spec validation', () => {
  it('rejects names not matching snake_case verb_noun', () => {
    expect(() =>
      defineAction({ ...baseSpec, name: 'DoThing', risk: 'read' }),
    ).toThrow(/Invalid action name/);
    expect(() =>
      defineAction({ ...baseSpec, name: '1foo', risk: 'read' }),
    ).toThrow(/Invalid action name/);
  });

  it('rejects malformed version', () => {
    expect(() =>
      defineAction({ ...baseSpec, version: 'v1', risk: 'read' }),
    ).toThrow(/Invalid version/);
  });

  it('rejects description > 200 chars', () => {
    expect(() =>
      defineAction({
        ...baseSpec,
        description: 'x'.repeat(201),
        risk: 'read',
      }),
    ).toThrow(/Description.*must be/);
  });

  it('requires write actions to explicitly set requiresConfirmation', () => {
    expect(() => defineAction({ ...baseSpec, risk: 'write' })).toThrow(
      /must explicitly set requiresConfirmation/,
    );
  });

  it('refuses dangerous actions opting out of confirmation', () => {
    expect(() =>
      defineAction({
        ...baseSpec,
        risk: 'dangerous',
        requiresConfirmation: false,
      }),
    ).toThrow(/cannot opt out of confirmation/);
  });

  it('refuses read actions that require confirmation', () => {
    expect(() =>
      defineAction({
        ...baseSpec,
        risk: 'read',
        requiresConfirmation: true,
        summary: () => 's',
      }),
    ).toThrow(/should not require confirmation/);
  });

  it('requires summary() when requiresConfirmation is true', () => {
    expect(() =>
      defineAction({
        ...baseSpec,
        risk: 'write',
        requiresConfirmation: true,
      }),
    ).toThrow(/no summary\(\) provided/);
  });

  it('accepts a well-formed write action with summary', () => {
    const a = defineAction({
      ...baseSpec,
      risk: 'write',
      requiresConfirmation: true,
      summary: () => 'will do thing',
    });
    expect(a.spec.name).toBe('do_thing');
    expect(a.spec.aiInvocable).toBe(true);
  });

  it('respects aiInvocable: false to keep an action off AI surfaces', () => {
    const a = defineAction({ ...baseSpec, risk: 'read', aiInvocable: false });
    expect(a.spec.aiInvocable).toBe(false);
  });
});
