/**
 * Anomaly detector — see STANDARD.md §14 + §21-C
 *
 * Cheap sliding-window heuristics over the audit log. Surfaces three
 * anomaly families an admin would actually want to see:
 *
 *   write_spike       — high volume of writes by one user in short window
 *   error_burst       — error rate by one user exceeds threshold
 *   loop_attempts     — LOOP_DETECTED firing repeatedly (jailbreak signal)
 *
 * Defaults are deliberately conservative — tune for your platform.
 */

import type { AuditQueryable, AuditRecord } from './audit-query.js';

export interface AnomalyFinding {
  kind: 'write_spike' | 'error_burst' | 'loop_attempts';
  user_id: string;
  window_minutes: number;
  count: number;
  threshold: number;
  sample_record_ids: string[];
  first_seen: string;
  last_seen: string;
  severity: 'low' | 'medium' | 'high';
}

export interface AnomalyConfig {
  writeSpike?: { minutes: number; threshold: number };
  errorBurst?: { minutes: number; threshold: number };
  loopAttempts?: { minutes: number; threshold: number };
}

const DEFAULTS: Required<AnomalyConfig> = {
  writeSpike: { minutes: 1, threshold: 50 },
  errorBurst: { minutes: 5, threshold: 20 },
  loopAttempts: { minutes: 5, threshold: 5 },
};

export class AnomalyDetector {
  constructor(
    private audit: AuditQueryable,
    private config: AnomalyConfig = {},
  ) {}

  async scan(): Promise<AnomalyFinding[]> {
    const cfg = {
      writeSpike: this.config.writeSpike ?? DEFAULTS.writeSpike,
      errorBurst: this.config.errorBurst ?? DEFAULTS.errorBurst,
      loopAttempts: this.config.loopAttempts ?? DEFAULTS.loopAttempts,
    };

    const all = await this.audit.query({ limit: 500 });
    const records = all.items;

    return [
      ...this.findSpike(records, cfg.writeSpike, 'write_spike', (r) => isWriteSuccess(r)),
      ...this.findSpike(records, cfg.errorBurst, 'error_burst', (r) => r.status === 'error'),
      ...this.findSpike(
        records,
        cfg.loopAttempts,
        'loop_attempts',
        (r) => r.error_code === 'LOOP_DETECTED',
      ),
    ];
  }

  private findSpike(
    records: AuditRecord[],
    window: { minutes: number; threshold: number },
    kind: AnomalyFinding['kind'],
    predicate: (r: AuditRecord) => boolean,
  ): AnomalyFinding[] {
    const windowMs = window.minutes * 60_000;
    const now = Date.now();

    const recent = records.filter(
      (r) => predicate(r) && now - new Date(r.timestamp).getTime() < windowMs,
    );

    const byUser = new Map<string, AuditRecord[]>();
    for (const r of recent) {
      const u = r.actor_user_id ?? 'unknown';
      const bucket = byUser.get(u) ?? [];
      bucket.push(r);
      byUser.set(u, bucket);
    }

    const findings: AnomalyFinding[] = [];
    for (const [user_id, recs] of byUser.entries()) {
      if (recs.length < window.threshold) continue;
      const severity: AnomalyFinding['severity'] =
        recs.length >= window.threshold * 4
          ? 'high'
          : recs.length >= window.threshold * 2
            ? 'medium'
            : 'low';
      findings.push({
        kind,
        user_id,
        window_minutes: window.minutes,
        count: recs.length,
        threshold: window.threshold,
        sample_record_ids: recs.slice(0, 5).map((r) => r.id),
        first_seen: recs[recs.length - 1].timestamp, // records come newest-first
        last_seen: recs[0].timestamp,
        severity,
      });
    }
    return findings;
  }
}

function isWriteSuccess(r: AuditRecord): boolean {
  if (r.status !== 'success') return false;
  // Heuristic: writes have a non-null confirmation in the data
  const conf = r.data?.confirmation as { token?: string } | null | undefined;
  return !!conf?.token;
}
