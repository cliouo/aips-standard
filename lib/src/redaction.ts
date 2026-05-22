/**
 * Output redaction — see STANDARD.md §11
 *
 * Declarative field-level masking. Sensitive fields are tagged on the Zod
 * schema via `.describe()` metadata or a side-channel registry; the
 * redaction middleware walks the output and applies the matching mask
 * based on the calling user's roles.
 *
 * Two conventions are supported:
 *
 *   1. Convention by name + classification map (simple, recommended):
 *      pass a FieldPolicy { 'email': { classification: 'pii', maskedForm: partialEmail } }
 *      and any output property whose key matches gets masked.
 *
 *   2. Explicit per-action: an Action's output schema can attach
 *      `.describe('aips:classification=pii')` to a field.
 *
 * This file ships the simple convention; a project can build richer
 * declarative policy on top.
 */

import type { Context } from './types.js';

export type Classification = 'public' | 'internal' | 'pii' | 'secret';

export interface FieldRule {
  classification: Classification;
  /** Who can see the unredacted value. */
  visibleTo: Array<'self' | 'admin' | 'support' | 'any'>;
  /** Custom masker; if omitted, returns null for masked fields. */
  maskedForm?: (value: unknown) => unknown;
}

export type FieldPolicy = Record<string, FieldRule>;

export interface RedactionContext {
  userRoles: string[];
  /** Optional: pass when checking "self" — e.g. masking out own data. */
  selfFieldName?: string;
  selfValue?: unknown;
}

/**
 * Common maskers.
 */
export const masks = {
  partialEmail: (v: unknown) => {
    if (typeof v !== 'string') return v;
    const [local, domain] = v.split('@');
    if (!domain) return '***';
    return local.slice(0, 1) + '***@' + domain;
  },
  partialPhone: (v: unknown) => {
    if (typeof v !== 'string') return v;
    if (v.length < 4) return '****';
    return v.slice(0, 3) + '****' + v.slice(-2);
  },
  redactedString: () => '[REDACTED]',
  hash: (v: unknown) => {
    if (typeof v !== 'string') return v;
    return 'hash:' + v.slice(0, 6) + '…';
  },
};

function canSee(rule: FieldRule, rctx: RedactionContext): boolean {
  if (rule.visibleTo.includes('any')) return true;
  for (const role of rctx.userRoles) {
    if (rule.visibleTo.includes(role as any)) return true;
  }
  // "self" handling: caller must pass selfFieldName/selfValue
  return false;
}

/**
 * Walk an object/array, masking any property whose key has a rule.
 * Returns a new structure; does not mutate input.
 */
export function redact(
  value: unknown,
  policy: FieldPolicy,
  rctx: RedactionContext,
): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, policy, rctx));
  if (typeof value !== 'object') return value;

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    const rule = policy[key];
    if (!rule) {
      out[key] = redact(v, policy, rctx); // recurse
      continue;
    }
    if (canSee(rule, rctx)) {
      out[key] = redact(v, policy, rctx);
    } else {
      out[key] = rule.maskedForm ? rule.maskedForm(v) : null;
    }
  }
  return out;
}

/**
 * Build a redactor closure for a given platform policy.
 * The dispatcher invokes this on the output before returning.
 */
export function makeRedactor(policy: FieldPolicy) {
  return (output: unknown, ctx: Context): unknown =>
    redact(output, policy, { userRoles: ctx.user.roles });
}

export type Redactor = (output: unknown, ctx: Context) => unknown;
