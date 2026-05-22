/**
 * A2A (Agent-to-Agent) adapter — see https://a2a-protocol.org
 *
 * Exposes the Refract registry as an A2A server so other agents (Google ADK,
 * IBM watsonx Orchestrate, LangChain agents, custom) can invoke our
 * actions via JSON-RPC. Mirror surface of our REST/MCP adapters, with
 * mappings from AAT records to A2A Tasks.
 *
 * Scope: minimal compliance — Agent Card + SendMessage + GetTask +
 * ListTasks. Streaming, push notifications, multi-tenant push configs
 * deferred.
 *
 * Action invocation convention:
 *   The client sends a Message whose first Part is `{data: {name, input,
 *   confirmation_token?}}`. That deterministically routes to a dispatch
 *   call. Text-only Messages are not interpreted — that's a higher-level
 *   agent's job, not the A2A protocol's.
 */

import type { Express, Request, Response } from 'express';
import type { ActionRegistry } from '../registry.js';
import type { ContextFactory } from '../types.js';
import type { AuditQueryable } from '../audit-query.js';
import type { AATOutcome, AATRecord } from '../aat.js';
import { RefractError, errors } from '../errors.js';

// ─── JSON-RPC envelopes ──────────────────────────────────────────────────────

interface JSONRPCRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id?: string | number | null;
}
interface JSONRPCSuccess {
  jsonrpc: '2.0';
  result: unknown;
  id: string | number | null;
}
interface JSONRPCError {
  jsonrpc: '2.0';
  error: { code: number; message: string; data?: unknown };
  id: string | number | null;
}

// ─── A2A types (subset we implement) ─────────────────────────────────────────

export type TaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_AUTH_REQUIRED';

export interface A2APart {
  text?: string;
  data?: Record<string, unknown>;
  mediaType?: string;
  metadata?: Record<string, unknown>;
}
export interface A2AMessage {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: 'ROLE_USER' | 'ROLE_AGENT';
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}
export interface A2AArtifact {
  artifactId: string;
  name?: string;
  parts: A2APart[];
}
export interface A2ATask {
  id: string;
  contextId?: string;
  status: { state: TaskState; message?: A2AMessage; timestamp?: string };
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

export interface AgentCard {
  id: string;
  name: string;
  provider: { name: string; url?: string; contact?: string };
  description?: string;
  capabilities: { streaming: boolean; pushNotifications: boolean; extendedAgentCard?: boolean };
  serviceEndpoint: string;
  skills?: Array<{
    id: string;
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    acceptedInputTypes?: string[];
  }>;
  securitySchemes?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
  version?: string;
}

// ─── Deps ────────────────────────────────────────────────────────────────────

export interface A2ADeps<API> {
  registry: ActionRegistry;
  audit: AuditQueryable;
  contextFactory: ContextFactory<API>;
  /** Provides identity from the inbound HTTP request (Bearer header etc) */
  authResolver: (req: Request) => Promise<{ user_id: string; user_roles: string[] }>;
  /** Used in Agent Card */
  agentInfo: {
    id: string;                  // e.g. urn:agent:acme-platform
    name: string;                // human-readable
    provider: { name: string; url?: string; contact?: string };
    serviceBaseURL: string;      // e.g. https://api.acme.com
    description?: string;
    version?: string;
  };
  /** Optional: customize the security schemes published in the Agent Card */
  securitySchemes?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
}

// ─── Mount ───────────────────────────────────────────────────────────────────

export function mountA2A<API>(app: Express, deps: A2ADeps<API>) {
  // GET /.well-known/agent-card.json
  app.get('/.well-known/agent-card.json', (_req, res) => {
    res.json(buildAgentCard(deps));
  });

  // POST /a2a/jsonrpc — single JSON-RPC endpoint
  app.post('/a2a/jsonrpc', async (req, res) => {
    const envelope = req.body as JSONRPCRequest;
    const id = envelope?.id ?? null;

    if (envelope?.jsonrpc !== '2.0' || !envelope.method) {
      return res.json(rpcError(id, -32600, 'Invalid Request'));
    }

    try {
      let auth: { user_id: string; user_roles: string[] };
      try {
        auth = await deps.authResolver(req);
      } catch {
        return res.json(
          rpcError(id, -32001, 'Unauthorized', { code: 'AuthenticationError' }),
        );
      }

      switch (envelope.method) {
        case 'SendMessage':
          return res.json(rpcOk(id, await handleSendMessage(envelope.params, deps, auth, req)));
        case 'GetTask':
          return res.json(rpcOk(id, await handleGetTask(envelope.params, deps)));
        case 'ListTasks':
          return res.json(rpcOk(id, await handleListTasks(envelope.params, deps)));
        default:
          return res.json(
            rpcError(id, -32601, `Method not found: ${envelope.method}`, {
              code: 'UnsupportedOperationError',
            }),
          );
      }
    } catch (e) {
      if (e instanceof RefractError) {
        return res.json(
          rpcError(id, -32000, e.messageForAI, { code: e.code, ...e.extra }),
        );
      }
      // eslint-disable-next-line no-console
      console.error('[a2a]', e);
      return res.json(
        rpcError(id, -32603, 'Internal error', { code: 'InternalError' }),
      );
    }
  });
}

// ─── Agent Card ──────────────────────────────────────────────────────────────

function buildAgentCard<API>(deps: A2ADeps<API>): AgentCard {
  // Group actions by domain to form skills
  const byDomain = deps.registry.byDomain();
  const skills: AgentCard['skills'] = [];

  for (const [domain, actions] of byDomain.entries()) {
    const aiActions = actions.filter((a) => a.spec.aiInvocable !== false);
    if (aiActions.length === 0) continue;
    skills.push({
      id: `${deps.agentInfo.id}#${domain}`,
      name: domain,
      description:
        `${domain} 域，包含 ${aiActions.length} 个 actions：` +
        aiActions.map((a) => a.spec.name).join(', '),
      acceptedInputTypes: ['application/json'],
    });
  }

  return {
    id: deps.agentInfo.id,
    name: deps.agentInfo.name,
    provider: deps.agentInfo.provider,
    description: deps.agentInfo.description,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    serviceEndpoint: `${deps.agentInfo.serviceBaseURL.replace(/\/$/, '')}/a2a/jsonrpc`,
    skills,
    securitySchemes: deps.securitySchemes ?? {
      bearerAuth: { type: 'http', scheme: 'bearer' },
    },
    security: deps.security ?? [{ bearerAuth: [] }],
    version: deps.agentInfo.version ?? '1.0',
  };
}

// ─── Method handlers ─────────────────────────────────────────────────────────

interface SendMessageParams {
  message: A2AMessage;
  configuration?: Record<string, unknown>;
}

async function handleSendMessage<API>(
  rawParams: unknown,
  deps: A2ADeps<API>,
  auth: { user_id: string; user_roles: string[] },
  req: Request,
): Promise<A2ATask | A2AMessage> {
  const params = rawParams as SendMessageParams | undefined;
  if (!params?.message?.parts?.length) {
    throw errors.invalidInput('message.parts is required and non-empty');
  }

  const dataPart = params.message.parts.find((p) => p.data !== undefined);
  if (!dataPart?.data) {
    throw errors.invalidInput(
      'A2A SendMessage must include a Part with `data: {name, input, confirmation_token?}` ' +
        'to invoke an action. Text-only Messages are not interpreted by this server.',
    );
  }

  const { name, input, confirmation_token } = dataPart.data as {
    name?: string;
    input?: unknown;
    confirmation_token?: string;
  };
  if (!name) throw errors.invalidInput('data.name is required');

  const ctx = await deps.contextFactory({
    user_id: auth.user_id,
    user_roles: auth.user_roles,
    delegation: {
      via: 'mcp', // A2A is closest in shape to MCP — both are agent-to-agent
      session_id: params.message.contextId,
      llm_message_id: params.message.messageId,
    },
    headers: req.headers as Record<string, string | undefined>,
    trace_id: params.message.messageId,
  });
  ctx.confirmation_token = confirmation_token;

  try {
    const result = await deps.registry.dispatch(name, input, ctx);
    return buildCompletedTask(name, params.message, result, deps);
  } catch (e) {
    if (e instanceof RefractError && e.code === 'PENDING_CONFIRMATION') {
      return buildInputRequiredTask(name, params.message, e, deps);
    }
    if (e instanceof RefractError) {
      return buildFailedTask(name, params.message, e);
    }
    throw e;
  }
}

interface GetTaskParams {
  id: string;
  historyLength?: number;
}

async function handleGetTask<API>(
  rawParams: unknown,
  deps: A2ADeps<API>,
): Promise<A2ATask> {
  const params = rawParams as GetTaskParams | undefined;
  if (!params?.id) throw errors.invalidInput('id is required');
  const rec = await deps.audit.get(params.id);
  if (!rec) {
    const err = new RefractError('NOT_FOUND', `Task ${params.id} not found`, 'TaskNotFound', 404);
    throw err;
  }
  return recordToTask(rec.aat);
}

interface ListTasksParams {
  contextId?: string;
  status?: TaskState;
  pageSize?: number;
  pageToken?: string;
}

async function handleListTasks<API>(
  rawParams: unknown,
  deps: A2ADeps<API>,
): Promise<{ tasks: A2ATask[]; nextPageToken: string; pageSize: number; totalSize: number }> {
  const params = (rawParams ?? {}) as ListTasksParams;
  const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 100);
  const statusFilter = params.status ? taskStateToOutcome(params.status) : undefined;

  const page = await deps.audit.query({
    status: statusFilter,
    limit: pageSize,
    cursor: params.pageToken,
  });

  const tasks = page.items
    .filter((r) => !params.contextId || r.aat.session_id === params.contextId)
    .map((r) => recordToTask(r.aat));

  return {
    tasks,
    nextPageToken: page.next_cursor ?? '',
    pageSize,
    totalSize: page.total,
  };
}

// ─── Builders ────────────────────────────────────────────────────────────────

function buildCompletedTask<API>(
  actionName: string,
  inMsg: A2AMessage,
  result: unknown,
  _deps: A2ADeps<API>,
): A2ATask {
  return {
    id: inMsg.messageId, // server-side: we'd use the AAT record id; demo uses message id
    contextId: inMsg.contextId,
    status: {
      state: 'TASK_STATE_COMPLETED',
      timestamp: new Date().toISOString(),
    },
    artifacts: [
      {
        artifactId: `art-${actionName}`,
        name: actionName,
        parts: [
          { data: { result }, mediaType: 'application/json' },
        ],
      },
    ],
    history: [inMsg],
  };
}

function buildInputRequiredTask<API>(
  actionName: string,
  inMsg: A2AMessage,
  err: RefractError,
  _deps: A2ADeps<API>,
): A2ATask {
  return {
    id: inMsg.messageId,
    contextId: inMsg.contextId,
    status: {
      state: 'TASK_STATE_INPUT_REQUIRED',
      timestamp: new Date().toISOString(),
      message: {
        messageId: `msg-${Date.now()}`,
        role: 'ROLE_AGENT',
        parts: [
          { text: String(err.extra.summary ?? err.messageForUser) },
          {
            data: {
              instruction:
                'Re-send SendMessage with the same data plus confirmation_token to execute',
              confirmation_token: err.extra.confirmation_token,
              expires_at: err.extra.expires_at,
              action_name: actionName,
            },
            mediaType: 'application/json',
          },
        ],
      },
    },
    history: [inMsg],
  };
}

function buildFailedTask(actionName: string, inMsg: A2AMessage, err: RefractError): A2ATask {
  const state: TaskState =
    err.code === 'PERMISSION_DENIED' || err.code === 'NEVER_ALLOWED'
      ? 'TASK_STATE_REJECTED'
      : err.code === 'UNAUTHORIZED'
        ? 'TASK_STATE_AUTH_REQUIRED'
        : 'TASK_STATE_FAILED';

  return {
    id: inMsg.messageId,
    contextId: inMsg.contextId,
    status: {
      state,
      timestamp: new Date().toISOString(),
      message: {
        messageId: `msg-${Date.now()}`,
        role: 'ROLE_AGENT',
        parts: [
          { text: err.messageForUser },
          { data: { error: err.code, action_name: actionName, ...err.extra }, mediaType: 'application/json' },
        ],
      },
    },
    history: [inMsg],
  };
}

function recordToTask(record: AATRecord): A2ATask {
  return {
    id: record.record_id,
    contextId: record.session_id,
    status: {
      state: outcomeToTaskState(record.outcome),
      timestamp: record.timestamp,
    },
    metadata: {
      action_type: record.action_type,
      tool_name: record.action_detail.tool_name,
    },
  };
}

function outcomeToTaskState(o: AATOutcome): TaskState {
  switch (o) {
    case 'success':
      return 'TASK_STATE_COMPLETED';
    case 'failure':
    case 'timeout':
      return 'TASK_STATE_FAILED';
    case 'denied':
      return 'TASK_STATE_REJECTED';
    case 'escalated':
      return 'TASK_STATE_INPUT_REQUIRED';
  }
}

function taskStateToOutcome(s: TaskState): 'success' | 'error' | undefined {
  if (s === 'TASK_STATE_COMPLETED') return 'success';
  if (s === 'TASK_STATE_FAILED' || s === 'TASK_STATE_REJECTED') return 'error';
  return undefined;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function rpcOk(id: string | number | null, result: unknown): JSONRPCSuccess {
  return { jsonrpc: '2.0', result, id };
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JSONRPCError {
  return { jsonrpc: '2.0', error: { code, message, data }, id };
}
