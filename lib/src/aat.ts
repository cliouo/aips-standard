/**
 * IETF Agent Audit Trail (AAT) — record schema + canonicalization + hash chain.
 *
 * Implements draft-sharif-agent-audit-trail-00.
 * See https://datatracker.ietf.org/doc/draft-sharif-agent-audit-trail/
 *
 * Why this exists:
 *   STANDARD.md §13 originally invented its own audit log shape. The IETF
 *   draft covers exactly the same need and maps cleanly to EU AI Act
 *   Art. 12, ISO/IEC 42001 Annex A, and SOC 2. We adopt AAT as the
 *   canonical wire format and translate the dispatcher's legacy audit
 *   data into AAT records server-side.
 *
 *   The dispatcher API (`ctx.audit.log(event, data)`) is unchanged —
 *   only the store internals know about AAT.
 *
 * Signature support (ECDSA P-256) is intentionally omitted from v0.1.
 * Records carry a `signature?: string` field; production deployments may
 * supply a signer hook later without breaking the chain.
 */

import crypto from 'node:crypto';

// ─── Enums (closed sets per AAT spec) ────────────────────────────────────────

export const AAT_ACTION_TYPES = [
  'tool_call',
  'tool_response',
  'decision',
  'delegation',
  'escalation',
  'error',
  'lifecycle',
] as const;
export type AATActionType = (typeof AAT_ACTION_TYPES)[number];

export const AAT_OUTCOMES = [
  'success',
  'failure',
  'timeout',
  'denied',
  'escalated',
] as const;
export type AATOutcome = (typeof AAT_OUTCOMES)[number];

export const AAT_TRUST_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const;
export type AATTrustLevel = (typeof AAT_TRUST_LEVELS)[number];

// ─── Record shape ────────────────────────────────────────────────────────────

/**
 * AAT record. All required fields per spec §3; optional fields and Refract
 * extensions live alongside but are namespaced (`refract_*`) to avoid future
 * collisions if AAT promotes them later.
 */
export interface AATRecord {
  // Required
  record_id: string;          // UUIDv4
  timestamp: string;          // RFC 3339 UTC
  agent_id: string;           // URI (e.g. urn:agent:foo.example)
  agent_version: string;      // SemVer
  session_id: string;         // UUIDv4
  action_type: AATActionType;
  action_detail: Record<string, unknown>;
  outcome: AATOutcome;
  trust_level: AATTrustLevel;
  parent_record_id: string | null;
  prev_hash: string | null;   // hex SHA-256 of JCS(previous record)

  // Optional (AAT-defined)
  input_hash?: string;
  output_hash?: string;
  latency_ms?: number;
  model_id?: string;
  risk_score?: number;
  cost_estimate?: { amount: number; currency: string; breakdown?: Record<string, number> };
  jurisdiction?: string;      // ISO 3166-1 alpha-2
  human_override?: { operator_id: string; reason: string; original_action: unknown };
  signature?: string;         // Base64url ECDSA P-256, optional

  // Refract extensions (namespaced)
  refract_trace_id?: string;
  refract_undoable?: boolean;
  refract_input_snapshot?: unknown;
  refract_output_snapshot?: unknown;
}

// ─── Canonicalization (JCS-compatible for our value shapes) ──────────────────

/**
 * Stable JSON serialization. RFC 8785 (JCS) for the value shapes Refract
 * produces — flat objects of strings/numbers/booleans/nulls/arrays.
 *
 * For full RFC 8785 compliance (e.g. weird unicode normalization, -0
 * handling, very large integers), production deployments SHOULD swap in
 * the `canonicalize` npm package. The function below is the common
 * subset and is deterministic for AAT records as we emit them.
 */
export function jcsCanonicalize(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(sort);
    const obj = v as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        const sorted = sort(obj[k]);
        if (sorted !== undefined) acc[k] = sorted;
        return acc;
      }, {});
  };
  return JSON.stringify(sort(value));
}

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Compute the prev_hash for record N+1 given record N.
 * Hashes the entire stored record (including signature, if present).
 */
export function hashRecord(record: AATRecord): string {
  return sha256Hex(jcsCanonicalize(record));
}

// ─── Construction ────────────────────────────────────────────────────────────

export interface AATAgentIdentity {
  agent_id: string;       // e.g. "urn:agent:acme-platform"
  agent_version: string;  // e.g. "0.1.0"
  trust_level?: AATTrustLevel;  // default L2
  jurisdiction?: string;
}

export interface AATBuildOptions {
  identity: AATAgentIdentity;
  session_id?: string;
  parent?: AATRecord | null;
}

/**
 * Build a new AAT record from minimal inputs. Maintains the hash chain
 * automatically when `parent` is supplied.
 */
export function buildAATRecord(
  fields: Omit<
    AATRecord,
    'record_id' | 'timestamp' | 'agent_id' | 'agent_version' | 'session_id' | 'trust_level' | 'parent_record_id' | 'prev_hash'
  >,
  opts: AATBuildOptions,
): AATRecord {
  const { identity, session_id, parent } = opts;
  return {
    record_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    agent_id: identity.agent_id,
    agent_version: identity.agent_version,
    session_id: session_id ?? crypto.randomUUID(),
    trust_level: identity.trust_level ?? 'L2',
    parent_record_id: parent?.record_id ?? null,
    prev_hash: parent ? hashRecord(parent) : null,
    ...fields,
  };
}

// ─── Translation from legacy Refract audit data ─────────────────────────────────

/**
 * Convert the dispatcher's legacy audit payload into an AAT record's
 * action_detail. The dispatcher emits fields like `actor_user_id`,
 * `delegation`, `action.{name,version}`, etc. AAT keeps these nested
 * under `action_detail` so the top-level schema stays fixed.
 */
export interface LegacyDispatcherAudit {
  trace_id?: string;
  actor_user_id?: string;
  delegation?: { via?: string; session_id?: string; api_key_id?: string; llm_model?: string; llm_message_id?: string };
  action?: { name?: string; version?: string };
  input_hash?: string | null;
  status?: string;
  error_code?: string | null;
  duration_ms?: number;
  confirmation?: { token?: string; confirmed_at?: string } | null;
  input_snapshot?: unknown;
  output_snapshot?: unknown;
  undoable?: boolean;
  reason?: string;            // for never_list_blocked
  original_id?: string;       // for action_undone
}

export function translateToAAT(
  event: string,
  data: LegacyDispatcherAudit,
  opts: AATBuildOptions,
): AATRecord {
  const action_type = pickActionType(event);
  const outcome = pickOutcome(event, data);

  const action_detail: Record<string, unknown> = {
    event,
    tool_name: data.action?.name,
    tool_version: data.action?.version,
    actor: data.actor_user_id ? { user_id: data.actor_user_id } : undefined,
    delegation: data.delegation,
    confirmation: data.confirmation ?? undefined,
    reason: data.reason,
    original_id: data.original_id,
    error: data.error_code ? { code: data.error_code } : undefined,
  };

  // Strip undefined for cleaner records
  for (const k of Object.keys(action_detail)) {
    if (action_detail[k] === undefined) delete action_detail[k];
  }

  return buildAATRecord(
    {
      action_type,
      action_detail,
      outcome,
      input_hash: data.input_hash ?? undefined,
      latency_ms: data.duration_ms,
      model_id: data.delegation?.llm_model,
      refract_trace_id: data.trace_id,
      refract_undoable: data.undoable,
      refract_input_snapshot: data.input_snapshot,
      refract_output_snapshot: data.output_snapshot,
    },
    opts,
  );
}

function pickActionType(event: string): AATActionType {
  if (event === 'never_list_blocked') return 'tool_call';
  if (event === 'action_undone') return 'decision';
  if (event === 'action_executed') return 'tool_call';
  if (event.endsWith('_error')) return 'error';
  return 'tool_call';
}

function pickOutcome(event: string, data: LegacyDispatcherAudit): AATOutcome {
  if (event === 'never_list_blocked') return 'denied';
  if (data.status === 'success') return 'success';
  if (data.error_code === 'PERMISSION_DENIED' || data.error_code === 'NEVER_ALLOWED') return 'denied';
  if (data.error_code === 'UNAVAILABLE' || data.error_code === 'INTERNAL_ERROR') return 'failure';
  if (data.status === 'error') return 'failure';
  return 'success';
}

// ─── Verification ────────────────────────────────────────────────────────────

/**
 * Walk records in order, verify every prev_hash matches its predecessor.
 * Returns the first broken index, or -1 if the entire chain is intact.
 */
export function verifyChain(records: readonly AATRecord[]): number {
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (i === 0) {
      if (r.prev_hash !== null || r.parent_record_id !== null) return i;
      continue;
    }
    const prev = records[i - 1];
    if (r.parent_record_id !== prev.record_id) return i;
    if (r.prev_hash !== hashRecord(prev)) return i;
  }
  return -1;
}
