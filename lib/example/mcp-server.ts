/**
 * MCP server entry — `npm run mcp` or invoke from Claude Desktop config:
 *
 *   {
 *     "mcpServers": {
 *       "acme": {
 *         "command": "npx",
 *         "args": ["tsx", "<abs-path>/example/mcp-server.ts"],
 *         "env": {
 *           "ACME_USER_ID": "u_demo"
 *         }
 *       }
 *     }
 *   }
 *
 * The MCP transport carries no user identity, so we read it from env vars
 * — your platform's MCP launcher would inject session-scoped credentials
 * (e.g. a short-lived JWT) the same way.
 */

import {
  ActionRegistry,
  MemoryIdempotencyStore,
  MemoryConfirmationStore,
  MemoryRateLimiter,
  MemoryLoopDetector,
  ConsoleAuditLogger,
  defaultNeverList,
  makeRedactor,
  masks,
  startMCPServer,
  errors,
  type FieldPolicy,
} from '../src/index.js';

import { platformAPI, type PlatformAPI } from './platform-api.js';
import { listCustomers } from './actions/list-customers.js';
import { inviteTeamMember } from './actions/invite-team-member.js';

const audit = new ConsoleAuditLogger();
const redactionPolicy: FieldPolicy = {
  email: { classification: 'pii', visibleTo: ['admin'], maskedForm: masks.partialEmail },
};

const registry = new ActionRegistry({
  idempotency: new MemoryIdempotencyStore(),
  confirmation: new MemoryConfirmationStore(),
  rateLimit: new MemoryRateLimiter(),
  loop: new MemoryLoopDetector(),
  redact: makeRedactor(redactionPolicy),
  neverList: defaultNeverList(),
});
registry.register(listCustomers, inviteTeamMember);

await startMCPServer({
  serverInfo: { name: 'acme', version: '0.1.0' },
  registry,
  contextFactory: async (req) => ({
    user: { id: req.user_id, roles: req.user_roles },
    delegation: req.delegation,
    trace_id: req.trace_id,
    api: platformAPI as PlatformAPI,
    audit,
    errors,
    currentTeam: () => 't_demo',
  }),
  authResolver: async () => ({
    user_id: process.env.ACME_USER_ID ?? 'u_demo',
    user_roles: (process.env.ACME_USER_ROLES ?? 'member').split(','),
  }),
});

// Stay alive — MCP server runs over stdio, no explicit listen
// (server.connect() returns after the transport closes)
