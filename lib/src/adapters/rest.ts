/**
 * REST adapter — mounts every Action as POST /api/v1/actions/<kebab-name>
 *
 * Generic over HTTP frameworks: the adapter exposes a single async handler
 * that takes (name, body, headers, userResolver) and returns { status, body }.
 *
 * An Express helper is provided below for convenience.
 */

import type { ActionRegistry } from '../registry.js';
import type { ContextFactory } from '../types.js';
import { RefractError, errors } from '../errors.js';

export interface RestRequest {
  actionName: string;
  body: unknown;
  headers: Record<string, string | undefined>;
  user_id: string;
  user_roles: string[];
}

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function createRestHandler<API>(
  registry: ActionRegistry,
  contextFactory: ContextFactory<API>,
) {
  return async function handle(req: RestRequest): Promise<RestResponse> {
    const trace_id = req.headers['x-trace-id'] ?? crypto.randomUUID();

    try {
      const ctx = await contextFactory({
        user_id: req.user_id,
        user_roles: req.user_roles,
        delegation: parseDelegation(req.headers),
        headers: req.headers,
        trace_id,
      });

      ctx.idempotency_key = req.headers['idempotency-key'];
      ctx.confirmation_token = req.headers['x-confirmation-token'];

      const result = await registry.dispatch(req.actionName, req.body, ctx);

      // Deprecation warning header (§15)
      const action = registry.get(req.actionName);
      const headers: Record<string, string> = {};
      if (action?.spec.deprecatedAt) {
        const removed = action.spec.removedAt ?? 'TBD';
        const replacement = action.spec.replacedBy
          ? `, use ${action.spec.replacedBy}`
          : '';
        headers['X-Deprecated'] = `deprecated since ${action.spec.deprecatedAt}, removed at ${removed}${replacement}`;
      }

      return { status: 200, body: result, headers };
    } catch (e) {
      if (e instanceof RefractError) {
        return { status: e.httpStatus, body: e.toJSON() };
      }
      // Never leak internal errors to AI/clients (§8)
      // eslint-disable-next-line no-console
      console.error('[Refract] unhandled error:', e);
      return {
        status: 500,
        body: errors.internalError().toJSON(),
      };
    }
  };
}

function parseDelegation(headers: Record<string, string | undefined>) {
  return {
    via: (headers['x-aips-via'] as any) ?? 'direct',
    session_id: headers['x-aips-session'],
    api_key_id: headers['x-aips-key-id'],
    llm_model: headers['x-aips-llm-model'],
    llm_message_id: headers['x-aips-llm-msg'],
  };
}

// ─── Express helper ──────────────────────────────────────────────────────────

import type { Express, Request, Response } from 'express';

/**
 * Mount Refract REST endpoints on an Express app under /api/v1/actions/*
 *
 * userResolver is your platform-specific auth: extract user_id from the
 * session cookie, API key, JWT — whatever your platform already does.
 */
export function mountExpress<API>(
  app: Express,
  registry: ActionRegistry,
  contextFactory: ContextFactory<API>,
  userResolver: (req: Request) => Promise<{ user_id: string; user_roles: string[] }>,
) {
  const handler = createRestHandler(registry, contextFactory);

  app.post('/api/v1/actions/:name', async (req: Request, res: Response) => {
    let auth: { user_id: string; user_roles: string[] };
    try {
      auth = await userResolver(req);
    } catch {
      const err = errors.unauthorized();
      return res.status(err.httpStatus).json(err.toJSON());
    }

    const result = await handler({
      actionName: req.params.name.replace(/-/g, '_'),
      body: req.body,
      headers: req.headers as Record<string, string | undefined>,
      user_id: auth.user_id,
      user_roles: auth.user_roles,
    });

    if (result.headers) {
      for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
    }
    res.status(result.status).json(result.body);
  });

  // Discoverability endpoint — list available actions
  app.get('/api/v1/actions', (_req, res) => {
    res.json({
      actions: registry.list().map((a) => ({
        name: a.spec.name,
        version: a.spec.version,
        description: a.spec.description,
        risk: a.spec.risk,
        domain: a.spec.domain,
        ai_invocable: a.spec.aiInvocable !== false,
        deprecated_at: a.spec.deprecatedAt ?? null,
      })),
    });
  });
}
