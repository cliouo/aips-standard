/**
 * Queryable audit log — see STANDARD.md §13 + §21
 *
 * v0.2 (post-AAT alignment):
 *   - Underlying storage is IETF Agent Audit Trail (AAT) records
 *   - Hash chain maintained automatically
 *   - Query interface unchanged — translates Refract-side concepts to AAT
 *     nested fields transparently
 *
 * The dispatcher does NOT need to know about AAT details. It calls
 * `ctx.audit.log(event, data)` with the same shape as v0.1; the store
 * translates and chains.
 */

import type { AuditLogger } from './types.js';
import {
  buildAATRecord,
  hashRecord,
  translateToAAT,
  verifyChain,
  type AATAgentIdentity,
  type AATRecord,
  type LegacyDispatcherAudit,
} from './aat.js';

/**
 * AuditRecord exposed to query callers. Carries the full AAT record plus
 * a flattened "index view" with the fields query helpers operate on.
 */
export interface AuditRecord {
  id: string;                  // alias for record_id (backward compat)
  event: string;               // mirror of action_detail.event
  timestamp: string;
  actor_user_id?: string;      // lifted from action_detail.actor.user_id
  action_name?: string;        // lifted from action_detail.tool_name
  error_code?: string | null;  // lifted from action_detail.error.code
  status?: string;             // mapped from outcome
  /** Full AAT record, signature-verifiable */
  aat: AATRecord;
  /** Legacy v0.1 raw data (deprecated — read fields via `aat` going forward) */
  data: Record<string, unknown>;
}

export interface AuditQuery {
  actorUserId?: string;
  actionName?: string;
  status?: 'success' | 'error';
  errorCode?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}

export interface AuditPage {
  items: AuditRecord[];
  total: number;
  next_cursor: string | null;
  truncated: boolean;
}

export interface AuditQueryable extends AuditLogger {
  query(q: AuditQuery): Promise<AuditPage>;
  get(id: string): Promise<AuditRecord | null>;
  /** Verify the AAT hash chain — returns -1 if intact, else broken index */
  verifyChain(): Promise<number>;
}

export interface MemoryAuditStoreOptions {
  identity: AATAgentIdentity;
  /** Echo to stdout for development; default true */
  echoToConsole?: boolean;
  /** Optional signer for AAT records — default: no signature */
  signer?: (canonicalBytes: string) => Promise<string> | string;
}

/**
 * In-memory store maintaining a hash-chained AAT record log.
 * Production: swap for an append-only DB / object store backend.
 */
export class MemoryAuditStore implements AuditQueryable {
  private records: AATRecord[] = [];
  private wrappers: AuditRecord[] = [];
  private last: AATRecord | null = null;
  private sessionId: string | null = null;

  constructor(private opts: MemoryAuditStoreOptions) {}

  async log(event: string, data: Record<string, unknown>): Promise<void> {
    const legacy = data as LegacyDispatcherAudit;
    const session_id = legacy.delegation?.session_id ?? this.sessionId ?? undefined;

    const record = translateToAAT(event, legacy, {
      identity: this.opts.identity,
      session_id,
      parent: this.last,
    });

    if (this.opts.signer) {
      const { signature: _, ...unsigned } = record;
      const sig = await this.opts.signer(
        // import lazily to keep this method synchronous-friendly
        (await import('./aat.js')).jcsCanonicalize(unsigned),
      );
      record.signature = sig;
    }

    this.records.push(record);
    this.last = record;
    if (!this.sessionId) this.sessionId = record.session_id;

    const wrapper: AuditRecord = {
      id: record.record_id,
      event,
      timestamp: record.timestamp,
      actor_user_id: (record.action_detail.actor as { user_id?: string } | undefined)?.user_id,
      action_name: record.action_detail.tool_name as string | undefined,
      error_code: (record.action_detail.error as { code?: string } | undefined)?.code ?? null,
      status: legacy.status ?? (record.outcome === 'success' ? 'success' : 'error'),
      aat: record,
      data,
    };
    this.wrappers.push(wrapper);

    if (this.opts.echoToConsole !== false) {
      // eslint-disable-next-line no-console
      console.log('[audit]', event, JSON.stringify(data));
    }
  }

  async get(id: string): Promise<AuditRecord | null> {
    return this.wrappers.find((r) => r.id === id) ?? null;
  }

  async query(q: AuditQuery): Promise<AuditPage> {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
    const sinceMs = q.since ? new Date(q.since).getTime() : 0;
    const untilMs = q.until ? new Date(q.until).getTime() : Infinity;

    let filtered = this.wrappers.filter((r) => {
      if (q.actorUserId && r.actor_user_id !== q.actorUserId) return false;
      if (q.actionName && r.action_name !== q.actionName) return false;
      if (q.status && r.status !== q.status) return false;
      if (q.errorCode && r.error_code !== q.errorCode) return false;
      const t = new Date(r.timestamp).getTime();
      if (t < sinceMs || t > untilMs) return false;
      return true;
    });

    filtered = filtered.slice().reverse();

    const total = filtered.length;
    const start = q.cursor ? Math.max(0, Number(q.cursor) || 0) : 0;
    const page = filtered.slice(start, start + limit);
    const next = start + limit < total ? String(start + limit) : null;

    return {
      items: page,
      total,
      next_cursor: next,
      truncated: next !== null,
    };
  }

  async verifyChain(): Promise<number> {
    return verifyChain(this.records);
  }

  /** Raw AAT records — for export / archival */
  rawAAT(): readonly AATRecord[] {
    return this.records;
  }

  /** Backward-compat alias used in tests */
  raw(): readonly AuditRecord[] {
    return this.wrappers;
  }
}
