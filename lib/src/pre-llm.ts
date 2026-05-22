/**
 * Pre-LLM redaction & region routing — see STANDARD.md §22
 *
 * Two related concerns:
 *
 *   1. PII redaction before send
 *      Tool results sometimes contain raw PII (emails, phones, names) that
 *      the *user* is allowed to see but the *LLM provider* should not.
 *      This module replaces such values with stable placeholders before
 *      the data leaves your infra, and provides a one-shot rehydrate map
 *      so the final user-facing response can be restored.
 *
 *      Threat model: leaking PII into LLM training logs or accidental
 *      cross-tenant retention. Defense: never send the raw value.
 *
 *   2. Region routing
 *      Map a user's region to the LLM endpoint to use (e.g. EU users →
 *      eu.api.anthropic.com). The router is a simple function; the
 *      AnthropicInvoker already accepts an explicit client, so callers
 *      can build the right client per-region from this map.
 *
 * Note: this is *different* from src/redaction.ts. That one masks
 * outputs returned to the *user*; this one masks payloads sent to the
 * *LLM*. They're complementary — most platforms want both.
 */

import crypto from 'node:crypto';

// ─── Detection ───────────────────────────────────────────────────────────────

export type PIIKind = 'email' | 'phone' | 'ssn' | 'credit_card' | 'ip' | 'token' | 'custom';

export interface PIIDetection {
  kind: PIIKind;
  pattern: RegExp;
}

/**
 * ORDER MATTERS: longer/more-specific patterns first so they consume their
 * own characters before greedier patterns can. e.g. credit_card must come
 * before phone, or phone will eat the first 12 digits of a 16-digit number.
 */
export const defaultDetections: PIIDetection[] = [
  { kind: 'email', pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { kind: 'token', pattern: /\b(sk-|pk-|ghp_|xoxb-)[A-Za-z0-9_-]{16,}/g },
  { kind: 'credit_card', pattern: /\b(?:\d[ -]?){13,19}\b/g },
  { kind: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: 'phone', pattern: /(?<!\d)(?:\+?\d{1,3}[\s.-]?)?\(?\d{3,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?!\d)/g },
  { kind: 'ip', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
];

// ─── Redaction with rehydration ──────────────────────────────────────────────

/**
 * Bidirectional mapping between real PII and stable placeholders.
 *
 * Stable means: the same input value gets the same placeholder within a
 * single session, so the LLM can reason about identity ("the user with
 * <pii:email:e4f7> wants to add <pii:email:e4f7> to ..."). Across
 * sessions placeholders are different — no cross-session correlation.
 */
export class PIIVault {
  private toPlaceholder = new Map<string, string>();
  private toReal = new Map<string, string>();
  private salt: string;

  constructor(salt?: string) {
    this.salt = salt ?? crypto.randomBytes(8).toString('hex');
  }

  /** Get or assign a stable placeholder for a real value. */
  shield(kind: PIIKind, real: string): string {
    const key = `${kind}:${real}`;
    let placeholder = this.toPlaceholder.get(key);
    if (!placeholder) {
      const tag = crypto
        .createHash('sha256')
        .update(this.salt + key)
        .digest('hex')
        .slice(0, 6);
      placeholder = `<pii:${kind}:${tag}>`;
      this.toPlaceholder.set(key, placeholder);
      this.toReal.set(placeholder, real);
    }
    return placeholder;
  }

  /** Replace placeholders with real values (rehydration on user-facing output). */
  rehydrate(text: string): string {
    let out = text;
    for (const [placeholder, real] of this.toReal.entries()) {
      out = out.split(placeholder).join(real);
    }
    return out;
  }

  /** Inverse — useful for testing. */
  get mappings(): Array<{ placeholder: string; real: string }> {
    return [...this.toReal.entries()].map(([placeholder, real]) => ({ placeholder, real }));
  }
}

/**
 * Walk arbitrary JSON-ish data, replacing detected PII with placeholders.
 * Returns a new structure.
 */
export function shieldPII(
  value: unknown,
  vault: PIIVault,
  detections: PIIDetection[] = defaultDetections,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return shieldString(value, vault, detections);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => shieldPII(v, vault, detections));
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = shieldPII(v, vault, detections);
  return out;
}

function shieldString(
  s: string,
  vault: PIIVault,
  detections: PIIDetection[],
): string {
  let out = s;
  for (const d of detections) {
    out = out.replace(d.pattern, (match) => vault.shield(d.kind, match));
  }
  return out;
}

// ─── Region routing ──────────────────────────────────────────────────────────

export type Region = 'us' | 'eu' | 'apac' | string;

export interface RegionEndpoint {
  baseURL: string;
  /** Optional region-specific API key */
  apiKey?: string;
}

export class RegionRouter {
  private endpoints = new Map<Region, RegionEndpoint>();
  private fallback: RegionEndpoint | null = null;

  set(region: Region, endpoint: RegionEndpoint): this {
    this.endpoints.set(region, endpoint);
    return this;
  }

  setFallback(endpoint: RegionEndpoint): this {
    this.fallback = endpoint;
    return this;
  }

  resolve(region: Region | undefined): RegionEndpoint {
    if (region && this.endpoints.has(region)) return this.endpoints.get(region)!;
    if (this.fallback) return this.fallback;
    throw new Error(
      `[Refract] No endpoint for region "${region}" and no fallback registered`,
    );
  }
}

// ─── Convenience: full pre-send pipeline ─────────────────────────────────────

export interface PreLLMOptions {
  detections?: PIIDetection[];
  /** Hook for further transformations after PII shielding (e.g. policy strip) */
  postShield?: (value: unknown) => unknown;
}

/**
 * Wrap a value bound for the LLM with PII shielding + a vault for
 * rehydrating the final user-facing message.
 *
 * Usage:
 *   const vault = new PIIVault();
 *   const safeBody = preparePromptForLLM(toolResult, vault);
 *   // ... send safeBody to LLM ...
 *   const finalText = vault.rehydrate(llmResponse);
 *   // ... show finalText to user ...
 */
export function preparePromptForLLM(
  value: unknown,
  vault: PIIVault,
  opts: PreLLMOptions = {},
): unknown {
  let shielded = shieldPII(value, vault, opts.detections);
  if (opts.postShield) shielded = opts.postShield(shielded);
  return shielded;
}
