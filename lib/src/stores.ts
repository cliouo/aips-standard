/**
 * In-memory reference implementations of the side-effect stores.
 *
 * Production:
 *   - IdempotencyStore  → Redis (24h TTL) or a PostgreSQL table
 *   - ConfirmationStore → Redis (≤ 5min TTL)
 *   - RateLimiter       → Redis token bucket / sliding window
 *   - LoopDetector      → in-process LRU per session is usually fine
 *
 * The interfaces here are the contract; swap implementations as needed.
 */

import crypto from 'node:crypto';
import { errors } from './errors.js';
import type { RateLimit } from './types.js';

// ─── Idempotency (§7) ────────────────────────────────────────────────────────

export interface IdempotencyStore {
  get(key: string): Promise<{ result?: unknown; error?: Record<string, unknown> } | null>;
  set(
    key: string,
    value: { result?: unknown; error?: Record<string, unknown> },
    ttlSec: number,
  ): Promise<void>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private store = new Map<string, { value: any; expiresAt: number }>();

  async get(key: string) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: any, ttlSec: number) {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
  }
}

// ─── Confirmation (§6) ───────────────────────────────────────────────────────

export interface ConfirmationStore {
  /** Issue a fresh token bound to (user, action, input_hash). Returns the token. */
  issue(userId: string, actionName: string, inputHash: string, ttlSec: number): Promise<string>;
  /** Consume must succeed exactly once; subsequent calls return false. */
  consume(
    userId: string,
    actionName: string,
    inputHash: string,
    token: string,
  ): Promise<boolean>;
}

export class MemoryConfirmationStore implements ConfirmationStore {
  private tokens = new Map<
    string,
    { userId: string; action: string; inputHash: string; expiresAt: number }
  >();

  async issue(userId: string, actionName: string, inputHash: string, ttlSec: number) {
    const token = 'ct_' + crypto.randomBytes(16).toString('hex');
    this.tokens.set(token, {
      userId,
      action: actionName,
      inputHash,
      expiresAt: Date.now() + ttlSec * 1000,
    });
    return token;
  }

  async consume(userId: string, actionName: string, inputHash: string, token: string) {
    const entry = this.tokens.get(token);
    if (!entry) return false;
    if (entry.expiresAt < Date.now()) {
      this.tokens.delete(token);
      return false;
    }
    if (
      entry.userId !== userId ||
      entry.action !== actionName ||
      entry.inputHash !== inputHash
    ) {
      // Critical: parameter changed since token was issued — reject.
      return false;
    }
    this.tokens.delete(token);
    return true;
  }
}

// ─── Rate limit (§14) ────────────────────────────────────────────────────────

export interface RateLimiter {
  check(
    userId: string,
    actionName: string,
    limit: RateLimit,
  ): Promise<{ allowed: boolean; retry_after?: number }>;
}

export class MemoryRateLimiter implements RateLimiter {
  private windows = new Map<string, number[]>();

  async check(userId: string, actionName: string, limit: RateLimit) {
    const now = Date.now();
    const key = `${userId}:${actionName}`;
    const log = (this.windows.get(key) ?? []).filter((t) => now - t < 24 * 60 * 60 * 1000);

    const hour = log.filter((t) => now - t < 60 * 60 * 1000).length;
    const day = log.length;

    if (limit.perUserPerHour !== undefined && hour >= limit.perUserPerHour) {
      return { allowed: false, retry_after: 60 * 60 };
    }
    if (limit.perUserPerDay !== undefined && day >= limit.perUserPerDay) {
      return { allowed: false, retry_after: 24 * 60 * 60 };
    }

    log.push(now);
    this.windows.set(key, log);
    return { allowed: true };
  }
}

// ─── Loop detection (§14) ────────────────────────────────────────────────────

export interface LoopDetector {
  /** Throws LOOP_DETECTED if the same (action, input_hash) repeats too often */
  check(userId: string, actionName: string, inputHash: string): Promise<void>;
}

export class MemoryLoopDetector implements LoopDetector {
  private recent = new Map<string, { hashes: string[]; at: number }>();
  private threshold = 3;
  private windowMs = 60_000;

  async check(userId: string, actionName: string, inputHash: string) {
    const key = `${userId}:${actionName}`;
    const now = Date.now();
    const entry = this.recent.get(key);
    let hashes: string[] = [];
    if (entry && now - entry.at < this.windowMs) {
      hashes = entry.hashes;
    }
    hashes.push(inputHash);
    if (hashes.length > 10) hashes = hashes.slice(-10);
    this.recent.set(key, { hashes, at: now });

    const sameCount = hashes.filter((h) => h === inputHash).length;
    if (sameCount > this.threshold) {
      throw errors.loopDetected();
    }
  }
}

// ─── Audit (§13) ─────────────────────────────────────────────────────────────

export class ConsoleAuditLogger {
  async log(event: string, data: Record<string, unknown>) {
    // In production: append-only DB / S3 / Kafka — never plain stdout.
    // eslint-disable-next-line no-console
    console.log('[audit]', event, JSON.stringify(data));
  }
}
