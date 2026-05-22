/**
 * Transparency endpoints — see STANDARD.md §21
 *
 * Mounts:
 *   GET  /api/v1/me/ai-context?route=...     (surface A)
 *   GET  /api/v1/me/ai-activity              (surface B)
 *   GET  /api/v1/me/ai-activity/:id
 *   POST /api/v1/me/ai-activity/:id/undo
 *   GET  /api/v1/me/ai-keys                  (surface B)
 *   POST /api/v1/me/ai-keys                  (create)
 *   POST /api/v1/me/ai-keys/:id/revoke
 *   GET  /api/v1/admin/ai-activity           (surface C)
 *   GET  /api/v1/admin/ai-anomalies          (surface C)
 *
 * Framework-agnostic at the core: each handler returns { status, body }.
 * An Express mount helper is provided.
 */

import type { Express, Request, Response } from 'express';
import type { ActionRegistry } from '../registry.js';
import type { ContextFactory } from '../types.js';
import type { ContextDecider } from '../context-decider.js';
import type { AuditQueryable } from '../audit-query.js';
import type { APIKeyStore } from '../api-keys.js';
import type { AnomalyDetector } from '../anomaly.js';
import { RefractError, errors } from '../errors.js';

export interface TransparencyDeps<API> {
  registry: ActionRegistry;
  contextFactory: ContextFactory<API>;
  decider: ContextDecider;
  audit: AuditQueryable;
  apiKeys: APIKeyStore;
  anomalies: AnomalyDetector;
  /** Resolves the authenticated user — same shape used by mountExpress */
  userResolver: (req: Request) => Promise<{ user_id: string; user_roles: string[] }>;
  /** Returns true if the given user is an admin (controls /admin/*) */
  isAdmin?: (userId: string, roles: string[]) => boolean;
}

const defaultIsAdmin = (_id: string, roles: string[]) => roles.includes('admin');

export function mountTransparency<API>(app: Express, deps: TransparencyDeps<API>) {
  const isAdmin = deps.isAdmin ?? defaultIsAdmin;

  // ── Surface A: what's active right now ────────────────────────────────────
  app.get('/api/v1/me/ai-context', async (req, res) => {
    try {
      const auth = await deps.userResolver(req);
      const ctx = deps.decider.resolve(
        {
          user: { id: auth.user_id, roles: auth.user_roles },
          route: (req.query.route as string | undefined) ?? '/',
          query: req.query.q as string | undefined,
        },
        deps.registry,
      );
      res.json(ctx);
    } catch (e) {
      handleErr(res, e);
    }
  });

  // ── Surface B: own activity ────────────────────────────────────────────────
  app.get('/api/v1/me/ai-activity', async (req, res) => {
    try {
      const auth = await deps.userResolver(req);
      const page = await deps.audit.query({
        actorUserId: auth.user_id,
        limit: clamp(Number(req.query.limit) || 50, 1, 200),
        cursor: req.query.cursor as string | undefined,
        since: req.query.since as string | undefined,
        until: req.query.until as string | undefined,
      });
      res.json(page);
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.get('/api/v1/me/ai-activity/:id', async (req, res) => {
    try {
      const auth = await deps.userResolver(req);
      const rec = await deps.audit.get(req.params.id);
      if (!rec || rec.actor_user_id !== auth.user_id) {
        return handleErr(res, errors.notFound('Activity'));
      }
      res.json(rec);
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.post('/api/v1/me/ai-activity/:id/undo', async (req, res) => {
    try {
      const auth = await deps.userResolver(req);
      const rec = await deps.audit.get(req.params.id);
      if (!rec || rec.actor_user_id !== auth.user_id) {
        return handleErr(res, errors.notFound('Activity'));
      }
      if (!rec.data.undoable) {
        return handleErr(res, errors.conflict('This action is not undoable'));
      }
      const actionName = rec.action_name ?? '';
      const action = deps.registry.get(actionName);
      if (!action?.spec.undo) {
        return handleErr(res, errors.conflict('No undo handler registered'));
      }

      const ctx = await deps.contextFactory({
        user_id: auth.user_id,
        user_roles: auth.user_roles,
        delegation: { via: 'direct' }, // undo is user-initiated, not AI
        headers: req.headers as Record<string, string | undefined>,
        trace_id: 'undo_' + req.params.id,
      });

      await action.spec.undo(ctx, {
        input: rec.data.input_snapshot,
        result: rec.data.output_snapshot,
      } as any);

      await deps.audit.log('action_undone', {
        original_id: rec.id,
        actor_user_id: auth.user_id,
        action: { name: actionName },
      });

      res.json({ ok: true, original_id: rec.id });
    } catch (e) {
      handleErr(res, e);
    }
  });

  // ── Surface B: own API keys ────────────────────────────────────────────────
  app.get('/api/v1/me/ai-keys', async (req, res) => {
    try {
      const auth = await deps.userResolver(req);
      const keys = await deps.apiKeys.list(auth.user_id);
      res.json({ items: keys });
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.post('/api/v1/me/ai-keys', async (req, res) => {
    try {
      const auth = await deps.userResolver(req);
      const { name, scopes, ttl_days } = req.body ?? {};
      if (!name || !Array.isArray(scopes)) {
        return handleErr(res, errors.invalidInput('name and scopes are required'));
      }
      const { key, secret } = await deps.apiKeys.create(auth.user_id, {
        name,
        scopes,
        ttlDays: ttl_days,
      });
      res.json({ key, secret /* shown ONCE — client must store immediately */ });
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.post('/api/v1/me/ai-keys/:id/revoke', async (req, res) => {
    try {
      const auth = await deps.userResolver(req);
      const out = await deps.apiKeys.revoke(auth.user_id, req.params.id);
      if (!out) return handleErr(res, errors.notFound('API key'));
      res.json(out);
    } catch (e) {
      handleErr(res, e);
    }
  });

  // ── Surface C: admin views ─────────────────────────────────────────────────
  app.get('/api/v1/admin/ai-activity', async (req, res) => {
    try {
      const auth = await deps.userResolver(req);
      if (!isAdmin(auth.user_id, auth.user_roles)) {
        return handleErr(res, errors.permissionDenied('Admin only'));
      }
      const page = await deps.audit.query({
        actorUserId: req.query.user_id as string | undefined,
        actionName: req.query.action as string | undefined,
        status: req.query.status as 'success' | 'error' | undefined,
        errorCode: req.query.error_code as string | undefined,
        since: req.query.since as string | undefined,
        until: req.query.until as string | undefined,
        limit: clamp(Number(req.query.limit) || 50, 1, 500),
        cursor: req.query.cursor as string | undefined,
      });
      res.json(page);
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.get('/api/v1/admin/ai-anomalies', async (req, res) => {
    try {
      const auth = await deps.userResolver(req);
      if (!isAdmin(auth.user_id, auth.user_roles)) {
        return handleErr(res, errors.permissionDenied('Admin only'));
      }
      const findings = await deps.anomalies.scan();
      res.json({ findings });
    } catch (e) {
      handleErr(res, e);
    }
  });
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function handleErr(res: Response, e: unknown) {
  if (e instanceof RefractError) {
    return res.status(e.httpStatus).json(e.toJSON());
  }
  // eslint-disable-next-line no-console
  console.error('[transparency]', e);
  res.status(500).json(errors.internalError().toJSON());
}
