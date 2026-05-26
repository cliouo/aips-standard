/**
 * Core types for Refract — see STANDARD.md §4 (Action Spec) and §5 (Delegation Identity)
 */

import type { z, ZodTypeAny } from 'zod';
import type { Errors } from './errors.js';

export type Risk = 'read' | 'write' | 'dangerous';

/** §24 — how an Action executes internally. 'generative' = handler runs a
 *  fixed LLM pipeline; the AI is a step *inside* the action, not the driver. */
export type ExecutionKind = 'deterministic' | 'generative';

/** §24 — provenance of an Action's output, surfaced to consumers so they can
 *  distinguish AI-generated content from system fact. */
export type Provenance = 'generated' | 'retrieved' | 'mixed';

export interface Delegation {
  via: 'ai_chat' | 'cli' | 'mcp' | 'a2a' | 'direct';
  session_id?: string;
  api_key_id?: string;
  llm_model?: string;
  llm_message_id?: string;
  /** MCP-specific: progress token from the originating tools/call request */
  mcp_progress_token?: string | number;
}

export interface AuditLogger {
  log(event: string, data: Record<string, unknown>): Promise<void>;
}

/**
 * Context is passed to every Action handler. Platforms inject their own
 * api client, audit logger, and any helper methods their actions need.
 */
export interface Context<API = unknown> {
  user: { id: string; roles: string[] };
  delegation: Delegation;

  // Request-scoped headers / tokens
  idempotency_key?: string;
  confirmation_token?: string;
  trace_id: string;

  // Injected capabilities
  api: API;
  audit: AuditLogger;
  errors: Errors;

  // Optional helpers — platform-specific, override in ContextFactory
  currentTeam?(): string;
}

/**
 * Factory that builds a Context from a raw incoming request.
 * Platforms implement this to wire their own auth, DB connections, etc.
 */
export type ContextFactory<API = unknown> = (req: {
  user_id: string;
  user_roles: string[];
  delegation: Delegation;
  headers: Record<string, string | undefined>;
  trace_id: string;
}) => Promise<Context<API>> | Context<API>;

export interface RateLimit {
  perUserPerHour?: number;
  perUserPerDay?: number;
}

export interface ActionExample<I> {
  prompt: string;
  input: I;
}

/**
 * Action specification — see STANDARD.md §4
 *
 * Generics:
 *   TI = input Zod schema type     (use z.infer<TI> for the data shape)
 *   TO = output Zod schema type
 *   API = platform API client type (whatever ctx.api should be)
 *
 * Using schema-as-generic (instead of data-as-generic) lets z.infer<>
 * unwrap input/output transformations (.default(), .optional(), etc.)
 * correctly per-call site.
 */
export interface ActionSpec<
  TI extends ZodTypeAny = ZodTypeAny,
  TO extends ZodTypeAny = ZodTypeAny,
  API = unknown,
> {
  // §4.1 MUST
  name: string;
  version: string;
  description: string;
  input: TI;
  output: TO;
  risk: Risk;

  // §24 — execution shape. 'generative' means the handler runs a fixed LLM
  // pipeline internally (expect latency + non-determinism). Default 'deterministic'.
  kind?: ExecutionKind;

  // §24 — output provenance marker, surfaced on the REST X-Refract-Provenance
  // header + audit record. Defaults: deterministic → 'retrieved',
  // generative → 'generated'. Use 'mixed' when output blends both.
  provenance?: Provenance;

  // §4 — default true; set false to hide from AI invocation entirely
  aiInvocable?: boolean;

  // §6 — must be explicit for write/dangerous
  requiresConfirmation?: boolean;

  // §7 — set true if handler is naturally idempotent
  idempotent?: boolean;

  // §4.2 SHOULD
  domain?: string;
  owner?: string;
  lastReviewed?: string;
  reviewIntervalDays?: number;
  rateLimit?: RateLimit;
  examples?: ActionExample<z.infer<TI>>[];
  deprecatedAt?: string;
  removedAt?: string;
  replacedBy?: string;

  // Business logic
  handler: (ctx: Context<API>, input: z.infer<TI>) => Promise<z.infer<TO>>;

  // Confirmation summary renderer (§6) — required if requiresConfirmation is true
  summary?: (input: z.infer<TI>) => string;

  /**
   * §21-B — optional compensating action. When defined, the transparency
   * endpoint exposes an "undo" button on completed activity entries.
   * Receives the original input + result; returns nothing.
   *
   * Examples:
   *   - invite_team_member → undo cancels the invite
   *   - delete_customer    → no undo (irreversible)
   *   - update_setting     → undo restores the prior value (captured in result)
   */
  undo?: (
    ctx: Context<API>,
    original: { input: z.infer<TI>; result: z.infer<TO> },
  ) => Promise<void>;
}

/**
 * Registered action — produced by defineAction()
 */
export interface Action<
  TI extends ZodTypeAny = ZodTypeAny,
  TO extends ZodTypeAny = ZodTypeAny,
  API = unknown,
> {
  spec: ActionSpec<TI, TO, API>;
}

/**
 * Shape of an input schema as a generic Zod object — used by adapters
 * that need to inspect input fields.
 */
export type AnyZodObject = ZodTypeAny;
