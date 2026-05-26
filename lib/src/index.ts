/**
 * @refract/core — public API surface
 *
 * See STANDARD.md for the underlying spec.
 */

export { defineAction } from './define-action.js';
export { ActionRegistry } from './registry.js';
export { RefractError, errors } from './errors.js';

export type {
  Action,
  ActionSpec,
  ActionExample,
  Context,
  ContextFactory,
  Delegation,
  AuditLogger,
  Risk,
  ExecutionKind,
  Provenance,
  RateLimit,
} from './types.js';

export {
  MemoryIdempotencyStore,
  MemoryConfirmationStore,
  MemoryRateLimiter,
  MemoryLoopDetector,
  ConsoleAuditLogger,
} from './stores.js';

export type {
  IdempotencyStore,
  ConfirmationStore,
  RateLimiter,
  LoopDetector,
} from './stores.js';

export type { DispatcherDeps } from './dispatcher.js';

export { mountExpress, createRestHandler } from './adapters/rest.js';
export {
  toClaudeTools,
  toSkillMarkdown,
  toCLISpec,
  validateSkillName,
} from './adapters/claude-tools.js';
export type {
  ClaudeTool,
  ClaudeToolFilter,
  CLICommandSpec,
  SkillMarkdownOptions,
} from './adapters/claude-tools.js';

// Optional adapter — needs @anthropic-ai/sdk
export { makeAnthropicInvoker } from './adapters/anthropic.js';
export type { AnthropicInvokerOptions } from './adapters/anthropic.js';

// Optional adapter — needs @modelcontextprotocol/sdk
export { startMCPServer } from './adapters/mcp.js';
export type { MCPServerOptions } from './adapters/mcp.js';

// OpenAPI 3.1 export
export { toOpenAPI } from './adapters/openapi.js';
export type { OpenAPIInfo } from './adapters/openapi.js';

// A2A (Agent-to-Agent) adapter
export { mountA2A } from './adapters/a2a.js';
export type {
  A2ADeps,
  A2APart,
  A2AMessage,
  A2AArtifact,
  A2ATask,
  AgentCard,
  TaskState,
} from './adapters/a2a.js';

// §13 — IETF Agent Audit Trail (AAT) primitives
export {
  buildAATRecord,
  hashRecord,
  jcsCanonicalize,
  sha256Hex,
  translateToAAT,
  verifyChain,
  AAT_ACTION_TYPES,
  AAT_OUTCOMES,
  AAT_TRUST_LEVELS,
} from './aat.js';
export type {
  AATRecord,
  AATActionType,
  AATOutcome,
  AATTrustLevel,
  AATAgentIdentity,
  AATBuildOptions,
  LegacyDispatcherAudit,
} from './aat.js';

// §21 — transparency data layer (AAT-backed)
export { MemoryAuditStore } from './audit-query.js';
export type {
  AuditRecord,
  AuditQuery,
  AuditPage,
  AuditQueryable,
  MemoryAuditStoreOptions,
} from './audit-query.js';

export { ContextDecider } from './context-decider.js';
export type {
  ContextRequest,
  ActiveContext,
  RouteRule,
  RoleRule,
} from './context-decider.js';

export { MemoryAPIKeyStore } from './api-keys.js';
export type {
  APIKeyRecord,
  APIKeyPublic,
  APIKeyStore,
} from './api-keys.js';

export { AnomalyDetector } from './anomaly.js';
export type { AnomalyFinding, AnomalyConfig } from './anomaly.js';

export { mountTransparency } from './adapters/transparency.js';
export type { TransparencyDeps } from './adapters/transparency.js';

// §10 — Spotlighting (Hines et al., 2024) — tool output isolation
export {
  asToolResult,
  errorAsToolResult,
  SYSTEM_PROMPT_FRAGMENT,
} from './tool-output.js';
export type {
  ToolUseResultBlock,
  SpotlightMode,
  SpotlightOptions,
} from './tool-output.js';

// §11 — output redaction (user-facing)
export {
  redact,
  makeRedactor,
  masks,
} from './redaction.js';
export type {
  Classification,
  FieldRule,
  FieldPolicy,
  RedactionContext,
  Redactor,
} from './redaction.js';

// §22 — pre-LLM PII shielding + region routing
export {
  PIIVault,
  RegionRouter,
  shieldPII,
  preparePromptForLLM,
  defaultDetections,
} from './pre-llm.js';
export type {
  PIIKind,
  PIIDetection,
  Region,
  RegionEndpoint,
  PreLLMOptions,
} from './pre-llm.js';

// §12 — never-list
export { NeverList, defaultNeverList } from './never-list.js';
export type { NeverListEntry } from './never-list.js';

// §17 — plans & checkpoints
export { PlanCoordinator } from './plan.js';
export type {
  PlanStep,
  ProposedPlan,
  CheckpointEvent,
  CheckpointHandler,
} from './plan.js';

// §18 — disambiguation
export {
  DisambiguationProviders,
  makeDisambiguateAction,
  DISAMBIGUATION_PROMPT_FRAGMENT,
} from './disambiguation.js';
export type {
  Candidate,
  DisambiguationSearch,
} from './disambiguation.js';

// §19 — eval harness
export {
  casesFromExamples,
  runEvals,
  printSummary,
} from './evals.js';
export type {
  EvalCase,
  EvalResult,
  EvalSummary,
  LLMInvocation,
  LLMInvoker,
} from './evals.js';

// Re-export zod so consumers don't pin a different version
export { z } from 'zod';
