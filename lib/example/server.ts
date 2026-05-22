/**
 * Minimal Express server demonstrating the full chain:
 *
 *   - Two registered actions (one read, one write)
 *   - In-memory stores for idempotency / confirmation / rate-limit / loop
 *   - REST endpoints under /api/v1/actions/*
 *   - /api/v1/tools.json — what type 1 (in-platform AI) would pass to Claude
 *   - /api/v1/skills/:domain.md — what type 2 (CLI + SKILL.md) ships
 *
 * Run:  npx tsx example/server.ts
 *
 * Then:
 *   # Read — no confirmation
 *   curl -s -X POST http://localhost:3000/api/v1/actions/list-customers \
 *        -H 'Content-Type: application/json' \
 *        -H 'X-User-Id: u_demo' \
 *        -H 'X-Refract-Via: ai_chat' \
 *        -d '{"limit": 2}'
 *
 *   # Write step 1 — get confirmation token
 *   curl -s -X POST http://localhost:3000/api/v1/actions/invite-team-member \
 *        -H 'Content-Type: application/json' \
 *        -H 'X-User-Id: u_demo' \
 *        -H 'X-Refract-Via: ai_chat' \
 *        -H 'Idempotency-Key: 11111111-1111-1111-1111-111111111111' \
 *        -d '{"email":"alice@example.com","role":"member"}'
 *
 *   # Write step 2 — confirm
 *   curl -s -X POST http://localhost:3000/api/v1/actions/invite-team-member \
 *        -H 'Content-Type: application/json' \
 *        -H 'X-User-Id: u_demo' \
 *        -H 'X-Refract-Via: ai_chat' \
 *        -H 'Idempotency-Key: 11111111-1111-1111-1111-111111111111' \
 *        -H 'X-Confirmation-Token: <token from step 1>' \
 *        -d '{"email":"alice@example.com","role":"member"}'
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRegistry,
  MemoryIdempotencyStore,
  MemoryConfirmationStore,
  MemoryRateLimiter,
  MemoryLoopDetector,
  MemoryAuditStore,
  MemoryAPIKeyStore,
  ContextDecider,
  AnomalyDetector,
  mountExpress,
  mountTransparency,
  mountA2A,
  toClaudeTools,
  toSkillMarkdown,
  toCLISpec,
  errors,
  defaultNeverList,
  makeRedactor,
  masks,
  toOpenAPI,
  type FieldPolicy,
} from '../src/index.js';

import { platformAPI, type PlatformAPI } from './platform-api.js';
import { listCustomers } from './actions/list-customers.js';
import { inviteTeamMember } from './actions/invite-team-member.js';

// ─── §11 Redaction policy ────────────────────────────────────────────────────
// Field-level rules — applied to every Action's output before return.
// Non-admin callers see a masked email; admins see the real value.
const redactionPolicy: FieldPolicy = {
  email: {
    classification: 'pii',
    visibleTo: ['admin'],
    maskedForm: masks.partialEmail,
  },
};

// ─── Build registry ──────────────────────────────────────────────────────────

const registry = new ActionRegistry({
  idempotency: new MemoryIdempotencyStore(),
  confirmation: new MemoryConfirmationStore(),
  rateLimit: new MemoryRateLimiter(),
  loop: new MemoryLoopDetector(),
  redact: makeRedactor(redactionPolicy),
  neverList: defaultNeverList(),
});

registry.register(listCustomers, inviteTeamMember);

// ─── Audit, API keys, decider, anomaly ───────────────────────────────────────

const audit = new MemoryAuditStore({
  identity: {
    agent_id: 'urn:agent:acme-platform',
    agent_version: '0.1.0',
    trust_level: 'L2',
  },
  echoToConsole: true,
});
const apiKeys = new MemoryAPIKeyStore();
const anomalies = new AnomalyDetector(audit);

const decider = new ContextDecider()
  .always('_meta')                                  // disambig, search — always on
  .onRoute('/team', 'team')                         // team page → team domain
  .onRoute('/customers', 'customer')                // customers page → customer domain
  .onRole('admin', 'team', 'customer');             // admins see everything

// ─── Context factory: how platform-specific concerns get injected ────────────

const contextFactory = async (req: {
  user_id: string;
  user_roles: string[];
  delegation: any;
  trace_id: string;
}) => ({
  user: { id: req.user_id, roles: req.user_roles },
  delegation: req.delegation,
  trace_id: req.trace_id,
  api: platformAPI as PlatformAPI,
  audit,
  errors,
  currentTeam: () => 't_demo',
});

// ─── Express setup ───────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// In a real platform: replace with real session / API-key resolution.
const userResolver = async (req: express.Request) => {
  const user_id = req.header('X-User-Id');
  if (!user_id) throw new Error('unauthorized');
  const roles = (req.header('X-User-Roles') ?? 'member').split(',');
  return { user_id, user_roles: roles };
};

mountExpress(app, registry, contextFactory, userResolver);

// §21 — transparency surfaces
mountTransparency(app, {
  registry,
  contextFactory,
  decider,
  audit,
  apiKeys,
  anomalies,
  userResolver,
});

// A2A — Agent-to-Agent protocol
mountA2A(app, {
  registry,
  audit,
  contextFactory,
  authResolver: userResolver,
  agentInfo: {
    id: 'urn:agent:acme-platform',
    name: 'Acme Platform Agent',
    provider: { name: 'Acme Corp', url: 'https://acme.example' },
    serviceBaseURL: 'http://localhost:3000',
    description: 'Refract demo platform — invite members, list customers',
    version: '0.1.0',
  },
});

// Static HTML demo
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.get('/transparency', (_req, res) => {
  res.sendFile(path.join(__dirname, 'transparency.html'));
});

// ─── Discoverability surfaces ────────────────────────────────────────────────

// What type 1 (in-platform AI) passes to Claude's tools[] parameter,
// optionally filtered by domain (e.g. user's current page).
app.get('/api/v1/tools.json', (req, res) => {
  const domain = req.query.domain as string | undefined;
  res.json(
    toClaudeTools(registry, domain ? { domains: [domain] } : {}),
  );
});

// What type 2 ships as SKILL.md inside the CLI binary.
app.get('/api/v1/skills/:domain.md', (req, res) => {
  res.type('text/markdown');
  res.send(
    toSkillMarkdown(registry, req.params.domain, {
      vendorPrefix: 'acme',
      description: `Acme platform · ${req.params.domain}`,
      license: 'Apache-2.0',
    }),
  );
});

// What the CLI build's codegen step consumes.
app.get('/api/v1/cli-spec.json', (_req, res) => {
  res.json(toCLISpec(registry));
});

// OpenAPI 3.1 — feeds Postman, openapi-generator, gateways, etc.
app.get('/api/v1/openapi.json', (_req, res) => {
  res.json(
    toOpenAPI(registry, {
      title: 'Acme Platform API (Refract)',
      version: '0.1.0',
      description: 'Generated from Refract Action registry',
      servers: [{ url: 'http://localhost:3000' }],
    }),
  );
});

// ─── Boot ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`Refract demo server on http://localhost:${PORT}`);
  console.log(`  POST /api/v1/actions/<kebab-action-name>`);
  console.log(`  GET  /api/v1/actions                 — discoverability`);
  console.log(`  GET  /api/v1/tools.json?domain=team  — Claude tool schema`);
  console.log(`  GET  /api/v1/skills/team.md          — SKILL.md for CLI`);
  console.log(`  GET  /api/v1/cli-spec.json           — CLI codegen input`);
  console.log(`  GET  /api/v1/openapi.json            — OpenAPI 3.1 spec`);
  console.log(`  GET  /api/v1/me/ai-context?route=…   — §21-A what's active`);
  console.log(`  GET  /api/v1/me/ai-activity          — §21-B my activity`);
  console.log(`  GET  /api/v1/me/ai-keys              — §21-B my API keys`);
  console.log(`  GET  /api/v1/admin/ai-activity       — §21-C org-wide stream`);
  console.log(`  GET  /api/v1/admin/ai-anomalies      — §21-C anomalies`);
  console.log(`  GET  /transparency                   — static HTML demo`);
  console.log(`  GET  /.well-known/agent-card.json    — A2A agent card`);
  console.log(`  POST /a2a/jsonrpc                    — A2A JSON-RPC (SendMessage/GetTask/ListTasks)`);
});
