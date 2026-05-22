/**
 * MCP adapter — exposes the Refract registry as a Model Context Protocol
 * stdio server.
 *
 * Why: STANDARD §20 mandates cross-client portability. Clients that
 * don't load SKILL.md (or don't have a Bash tool) — but do speak MCP —
 * can still consume your actions through this adapter.
 *
 * Mapping:
 *   Refract Action  ↔  MCP Tool
 *   §6 PENDING_CONFIRMATION  ↔  surfaced as isError=true result with the
 *                                 confirmation card payload; the host
 *                                 client renders/forwards to user
 *   §11 redaction, §13 audit  →  same dispatcher path, unchanged
 *
 * Limitations:
 *   - MCP has no native "two-step confirmation" semantics, so writes
 *     surface their confirmation token in the tool_result; the client
 *     must call the tool again with `confirmation_token` in the args.
 *     Document this in your tool descriptions.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  SetLevelRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { ActionRegistry } from '../registry.js';
import type { Context, ContextFactory } from '../types.js';
import { RefractError, errors } from '../errors.js';
import { asToolResult, errorAsToolResult } from '../tool-output.js';

export interface MCPServerOptions<API> {
  serverInfo: { name: string; version: string };
  registry: ActionRegistry;
  contextFactory: ContextFactory<API>;
  /**
   * MCP transport carries no user identity. The host must inject one;
   * typically via environment variables read by the host before spawning
   * the server. authResolver returns user_id + roles for this session.
   */
  authResolver: () => Promise<{ user_id: string; user_roles: string[] }>;
}

export async function startMCPServer<API>(opts: MCPServerOptions<API>): Promise<void> {
  let logLevel: string = 'info';

  const server = new Server(opts.serverInfo, {
    capabilities: {
      tools: {},
      prompts: {},
      logging: {},
    },
  });

  // logging/setLevel — clients control verbosity, useful for debugging
  server.setRequestHandler(SetLevelRequestSchema, async (req) => {
    logLevel = req.params.level;
    return {};
  });

  // prompts/list — expose plans as user-controlled prompts (empty for now;
  // real use: surface §17 plan templates the user can pick)
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: [] };
  });

  // ─── tools/list ────────────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: opts.registry.listAIInvocable().map((a) => {
        const schema = zodToJsonSchema(a.spec.input, {
          $refStrategy: 'none',
          target: 'jsonSchema7',
        }) as Record<string, any>;

        // MCP requires inputSchema to be an object schema. Inject the
        // confirmation_token field for write actions so clients can
        // complete the two-step flow without prior knowledge.
        if (a.spec.requiresConfirmation) {
          schema.properties = schema.properties ?? {};
          schema.properties.confirmation_token = {
            type: 'string',
            description:
              'Pass the token from a prior PENDING_CONFIRMATION result to authorize execution.',
          };
        }

        let description = a.spec.description;
        if (a.spec.requiresConfirmation) {
          description +=
            ' [write — first call returns a confirmation_token; replay with that token to execute]';
        }

        return {
          name: a.spec.name,
          description,
          inputSchema: schema,
        };
      }),
    };
  });

  // ─── tools/call ────────────────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { user_id, user_roles } = await opts.authResolver();
    const trace_id = crypto.randomUUID();

    const ctx: Context = await opts.contextFactory({
      user_id,
      user_roles,
      delegation: {
        via: 'mcp',
        // Don't conflate the MCP progressToken with llm_message_id —
        // they're different concepts. Keep progress tracking separate.
        mcp_progress_token: req.params._meta?.progressToken as string | number | undefined,
      },
      headers: {},
      trace_id,
    });

    // Pull confirmation_token out of the args (we injected it into the schema)
    const args = { ...(req.params.arguments ?? {}) } as Record<string, unknown>;
    if (typeof args.confirmation_token === 'string') {
      ctx.confirmation_token = args.confirmation_token;
      delete args.confirmation_token;
    }

    try {
      const result = await opts.registry.dispatch(req.params.name, args, ctx);
      const block = asToolResult('mcp_call', result);
      return {
        content: block.content,
        isError: false,
      };
    } catch (e) {
      const err = e instanceof RefractError ? e : errors.internalError(String(e));
      const block = errorAsToolResult('mcp_call', err);
      return {
        content: block.content,
        isError: true,
      };
    }
  });

  // ─── Transport ─────────────────────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
