/**
 * End-to-end demo — simulates one round of Type 1 (in-platform AI):
 *
 *   1. User: "邀请 alice@example.com 当管理员"
 *   2. LLM picks invite_team_member with parsed args
 *   3. Dispatcher returns 409 PENDING_CONFIRMATION with a summary
 *   4. Server emits a confirmation card to "the UI"
 *   5. The user accepts → request is replayed with the token
 *   6. Action executes, result is wrapped in <tool_output> for the LLM
 *   7. LLM produces the final user-facing message
 *
 * The mock LLM is deterministic so this whole flow is reproducible;
 * swap in a real Anthropic client and the only thing that changes is
 * step 2 + step 7.
 */

import {
  ActionRegistry,
  RefractError,
  MemoryIdempotencyStore,
  MemoryConfirmationStore,
  MemoryRateLimiter,
  MemoryLoopDetector,
  ConsoleAuditLogger,
  defaultNeverList,
  makeRedactor,
  masks,
  asToolResult,
  errorAsToolResult,
  toClaudeTools,
  SYSTEM_PROMPT_FRAGMENT,
  errors,
  type FieldPolicy,
} from '../src/index.js';

import { listCustomers } from './actions/list-customers.js';
import { inviteTeamMember } from './actions/invite-team-member.js';
import { platformAPI, type PlatformAPI } from './platform-api.js';
import { mockInvoke } from './mock-llm.js';

// ─── Setup (mirrors server.ts) ───────────────────────────────────────────────

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

const buildCtx = (extras: {
  confirmation_token?: string;
  idempotency_key?: string;
  llm_msg?: string;
}) => ({
  user: { id: 'u_demo', roles: ['member'] },
  delegation: {
    via: 'ai_chat' as const,
    session_id: 's_demo',
    llm_model: 'mock-llm',
    llm_message_id: extras.llm_msg,
  },
  trace_id: crypto.randomUUID(),
  api: platformAPI as PlatformAPI,
  audit,
  errors,
  currentTeam: () => 't_demo',
  confirmation_token: extras.confirmation_token,
  idempotency_key: extras.idempotency_key,
});

// ─── Simulated chat turn ─────────────────────────────────────────────────────

async function chatTurn(userMessage: string) {
  console.log('\n──────────────────────────────────────────');
  console.log(`USER: ${userMessage}`);
  console.log('──────────────────────────────────────────');
  console.log(`[system prompt fragment — §10 injection defense]\n${SYSTEM_PROMPT_FRAGMENT}`);

  const tools = toClaudeTools(registry);

  // Step 1 — LLM picks a tool
  const llmCall = await mockInvoke({
    system: 'You are an Acme platform assistant.',
    user: userMessage,
    tools,
  });

  if (llmCall.refused) {
    console.log(`\nASSISTANT (refused): ${llmCall.raw_text}`);
    return;
  }
  if (!llmCall.tool_name) {
    console.log(`\nASSISTANT: ${llmCall.raw_text}`);
    return;
  }

  const toolUseId = 'tu_' + crypto.randomUUID().slice(0, 8);
  console.log(`\nLLM → tool_use ${llmCall.tool_name}(${JSON.stringify(llmCall.tool_input)})`);

  const idempotencyKey = crypto.randomUUID();

  // Step 2 — Dispatcher (first call, no token)
  let result: unknown;
  try {
    result = await registry.dispatch(
      llmCall.tool_name!,
      llmCall.tool_input,
      buildCtx({ idempotency_key: idempotencyKey, llm_msg: toolUseId }),
    );
    console.log('\n→ Action returned directly (read or non-confirming write)');
  } catch (e) {
    if (e instanceof RefractError && e.code === 'PENDING_CONFIRMATION') {
      // Step 3 — Server emits a confirmation card to the chat UI
      const card = e.toJSON() as any;
      console.log('\n┌─ confirmation card to UI ─────────────');
      console.log(`│  ${card.summary}`);
      console.log(`│  [✓ 同意]   [✗ 取消]`);
      console.log('└───────────────────────────────────────');

      // Step 4 — Simulate user clicking ✓ (in real platform: websocket event)
      console.log('\n[user clicked 同意]');

      // Step 5 — Replay with token
      try {
        result = await registry.dispatch(
          llmCall.tool_name!,
          llmCall.tool_input,
          buildCtx({
            confirmation_token: card.confirmation_token,
            idempotency_key: idempotencyKey,
            llm_msg: toolUseId,
          }),
        );
      } catch (e2) {
        const toolResult = errorAsToolResult(
          toolUseId,
          e2 instanceof RefractError ? e2 : errors.internalError(String(e2)),
        );
        console.log('\nLLM ← tool_result (error):', JSON.stringify(toolResult, null, 2));
        return;
      }
    } else {
      const toolResult = errorAsToolResult(
        toolUseId,
        e instanceof RefractError ? e : errors.internalError(String(e)),
      );
      console.log('\nLLM ← tool_result (error):', JSON.stringify(toolResult, null, 2));
      return;
    }
  }

  // Step 6 — Wrap result for the LLM with §10 isolation tags
  const toolResult = asToolResult(toolUseId, result);
  console.log('\nLLM ← tool_result:');
  console.log(toolResult.content[0].text);

  // Step 7 — In a real loop we'd send this back to the LLM and let it
  // produce a user-facing summary. Here we stub a short confirmation.
  console.log(`\nASSISTANT: 已完成。${summarize(llmCall.tool_name!, result)}`);
}

function summarize(toolName: string, result: unknown): string {
  if (toolName === 'invite_team_member') {
    const r = result as { invite_id: string; status: string };
    return `邀请已${r.status === 'sent' ? '发送' : '排队'}（${r.invite_id}）。`;
  }
  if (toolName === 'list_customers') {
    const r = result as { items: any[]; total: number; truncated: boolean };
    return `共 ${r.total} 个客户，已展示 ${r.items.length} 个${r.truncated ? '（已截断）' : ''}。`;
  }
  return JSON.stringify(result);
}

// ─── Run a few representative turns ──────────────────────────────────────────

await chatTurn('看一下客户列表');                              // read, no confirmation
await chatTurn('邀请 alice@example.com 当管理员');             // write, confirmation flow
await chatTurn('清空所有客户');                                // refusal — model declines

console.log('\n══════════════════════════════════════════');
console.log('Demo complete.');
console.log('══════════════════════════════════════════');
