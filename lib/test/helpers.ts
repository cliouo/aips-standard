/**
 * Shared test helpers — build a registry & context with controllable doubles.
 */

import { z } from 'zod';
import {
  ActionRegistry,
  MemoryIdempotencyStore,
  MemoryConfirmationStore,
  MemoryRateLimiter,
  MemoryLoopDetector,
  defineAction,
  errors,
  type Context,
  type AuditLogger,
} from '../src/index.js';

export class CapturingAudit implements AuditLogger {
  events: Array<{ event: string; data: Record<string, unknown> }> = [];
  async log(event: string, data: Record<string, unknown>) {
    this.events.push({ event, data });
  }
}

export function makeRegistry(opts: Parameters<ActionRegistry['constructor']>[0] extends infer D ? Partial<D extends object ? D : never> : never = {} as never) {
  return new ActionRegistry({
    idempotency: new MemoryIdempotencyStore(),
    confirmation: new MemoryConfirmationStore(),
    rateLimit: new MemoryRateLimiter(),
    loop: new MemoryLoopDetector(),
    ...(opts as object),
  });
}

export function makeCtx(overrides: Partial<Context> = {}): Context {
  return {
    user: { id: 'u_test', roles: ['member'] },
    delegation: { via: 'ai_chat' },
    trace_id: 'trace_test',
    api: {},
    audit: new CapturingAudit(),
    errors,
    currentTeam: () => 't_test',
    ...overrides,
  };
}

// A simple read action — used in most tests
export const echoAction = defineAction({
  name: 'echo',
  version: '1.0',
  description: 'Test echo action',
  risk: 'read',
  input: z.object({ message: z.string() }),
  output: z.object({ message: z.string() }),
  async handler(_ctx, input) {
    return { message: input.message };
  },
});

// A simple write action — used for confirmation/idempotency tests
export const writeAction = defineAction({
  name: 'do_write',
  version: '1.0',
  description: 'Test write action',
  risk: 'write',
  requiresConfirmation: true,
  input: z.object({ value: z.string() }),
  output: z.object({ id: z.string(), value: z.string() }),
  summary: (input) => `Will set value to "${input.value}"`,
  async handler(_ctx, input) {
    return { id: 'id_' + input.value, value: input.value };
  },
});
