/**
 * API key store — see STANDARD.md §5 (delegation) + §21-B (user control)
 *
 * Users can see and revoke their own keys; admins can see (but not see
 * the secret value of) any user's keys.
 *
 * Important:
 *   - The full secret is returned EXACTLY ONCE — on creation.
 *   - All subsequent reads return only the prefix + last-used metadata.
 *   - Revocation is immediate (the dispatcher must consult this store).
 */

import crypto from 'node:crypto';

export interface APIKeyRecord {
  id: string;
  user_id: string;
  name: string;
  scopes: string[];
  /** First 8 chars of the key — safe to show */
  prefix: string;
  /** Hashed full key — only this is stored */
  hash: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface APIKeyPublic {
  id: string;
  user_id: string;
  name: string;
  scopes: string[];
  prefix: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  status: 'active' | 'expired' | 'revoked';
}

function hash(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function toPublic(rec: APIKeyRecord): APIKeyPublic {
  const now = Date.now();
  let status: APIKeyPublic['status'] = 'active';
  if (rec.revoked_at) status = 'revoked';
  else if (rec.expires_at && new Date(rec.expires_at).getTime() < now) status = 'expired';
  const { hash: _, ...rest } = rec;
  return { ...rest, status };
}

export interface APIKeyStore {
  create(
    userId: string,
    opts: { name: string; scopes: string[]; ttlDays?: number },
  ): Promise<{ key: APIKeyPublic; secret: string }>;
  list(userId: string): Promise<APIKeyPublic[]>;
  /** Admin variant */
  listAll(opts?: { userId?: string }): Promise<APIKeyPublic[]>;
  revoke(userId: string, id: string): Promise<APIKeyPublic | null>;
  /** Used by the auth resolver in the REST layer */
  resolve(secret: string): Promise<APIKeyPublic | null>;
}

export class MemoryAPIKeyStore implements APIKeyStore {
  private records: APIKeyRecord[] = [];
  private counter = 0;

  async create(userId: string, opts: { name: string; scopes: string[]; ttlDays?: number }) {
    const id = `key_${(++this.counter).toString(36)}`;
    const secret = 'refract_' + crypto.randomBytes(24).toString('base64url');
    const expiresAt = opts.ttlDays
      ? new Date(Date.now() + opts.ttlDays * 86400_000).toISOString()
      : null;

    const rec: APIKeyRecord = {
      id,
      user_id: userId,
      name: opts.name,
      scopes: opts.scopes,
      prefix: secret.slice(0, 8),
      hash: hash(secret),
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
      last_used_at: null,
      revoked_at: null,
    };
    this.records.push(rec);
    return { key: toPublic(rec), secret };
  }

  async list(userId: string) {
    return this.records.filter((r) => r.user_id === userId).map(toPublic);
  }

  async listAll(opts: { userId?: string } = {}) {
    return this.records
      .filter((r) => !opts.userId || r.user_id === opts.userId)
      .map(toPublic);
  }

  async revoke(userId: string, id: string) {
    const rec = this.records.find((r) => r.id === id && r.user_id === userId);
    if (!rec) return null;
    if (!rec.revoked_at) rec.revoked_at = new Date().toISOString();
    return toPublic(rec);
  }

  async resolve(secret: string) {
    const h = hash(secret);
    const rec = this.records.find((r) => r.hash === h);
    if (!rec) return null;
    if (rec.revoked_at) return null;
    if (rec.expires_at && new Date(rec.expires_at).getTime() < Date.now()) return null;
    rec.last_used_at = new Date().toISOString();
    return toPublic(rec);
  }
}
