/**
 * Never-List — see STANDARD.md §12
 *
 * Operations that MUST NOT be reachable through any AI-invocable action.
 * Two layers of defense:
 *
 *   1. Registration-time lint: reject any Action whose name or domain
 *      matches a forbidden pattern.
 *   2. Dispatch-time guard: refuse to execute (defense in depth — also
 *      catches actions registered before never-list was set).
 *
 * Production teams maintain this list in a separate file owned by
 * security/compliance, not by individual feature teams.
 */

export interface NeverListEntry {
  /** Action name regex or exact string */
  pattern: string | RegExp;
  /** Human-readable reason for audit trail */
  reason: string;
}

export class NeverList {
  private entries: NeverListEntry[] = [];

  add(entry: NeverListEntry): this {
    this.entries.push(entry);
    return this;
  }

  bulkAdd(entries: NeverListEntry[]): this {
    this.entries.push(...entries);
    return this;
  }

  /**
   * Returns the matching entry if the given action name is forbidden,
   * or null if it's allowed.
   */
  check(actionName: string): NeverListEntry | null {
    for (const entry of this.entries) {
      if (typeof entry.pattern === 'string') {
        if (entry.pattern === actionName) return entry;
      } else {
        if (entry.pattern.test(actionName)) return entry;
      }
    }
    return null;
  }

  list(): readonly NeverListEntry[] {
    return this.entries;
  }
}

/**
 * Default seed list — platforms SHOULD start from here and extend.
 * Names are illustrative; rename to match your domain.
 */
export const defaultNeverList = (): NeverList =>
  new NeverList().bulkAdd([
    {
      pattern: /^(delete|drop|destroy)_(tenant|organization|workspace)/,
      reason: 'Tenant/org deletion must go through manual operator workflow',
    },
    {
      pattern: /^transfer_ownership/,
      reason: 'Ownership transfer requires identity verification step UI cannot AI-confirm',
    },
    {
      pattern: /^(grant|set)_admin/,
      reason: 'Privilege escalation forbidden — never AI-invocable',
    },
    {
      pattern: /^bulk_delete/,
      reason: 'Bulk deletion must use platform UI with explicit confirmation',
    },
    {
      pattern: /^confirm_payment/,
      reason: 'Final payment confirmation must be user-initiated in UI',
    },
    {
      pattern: /^change_(mfa|sso|main_email|billing_email)/,
      reason: 'Identity-bearing settings require manual UI flow',
    },
    {
      pattern: /^revoke_(certificate|key|token)/,
      reason: 'Credential revocation must be user-initiated in security UI',
    },
  ]);
