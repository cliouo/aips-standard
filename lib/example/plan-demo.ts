/**
 * Plan & Checkpoint demo — see STANDARD.md §17
 *
 * Simulates a multi-step task:
 *   1. AI proposes a 3-step plan (list customers → invite two members)
 *   2. User approves the plan once
 *   3. Steps execute sequentially with checkpoint events
 *   4. Per-step confirmations are skipped because the plan is approved
 *      (except for steps in `dangerousActions` which always re-prompt)
 *
 * Also exercises §18 disambiguation as a meta tool.
 */

import {
  ActionRegistry,
  MemoryIdempotencyStore,
  MemoryConfirmationStore,
  MemoryRateLimiter,
  MemoryLoopDetector,
  ConsoleAuditLogger,
  PlanCoordinator,
  DisambiguationProviders,
  makeDisambiguateAction,
  defaultNeverList,
  errors,
} from '../src/index.js';

import { platformAPI, type PlatformAPI } from './platform-api.js';
import { listCustomers } from './actions/list-customers.js';
import { inviteTeamMember } from './actions/invite-team-member.js';

// ─── Setup ───────────────────────────────────────────────────────────────────

const audit = new ConsoleAuditLogger();
const plans = new PlanCoordinator();

// §18 — register a disambiguation domain for customers
const disambig = new DisambiguationProviders();
disambig.register('customer', async (ctx, query, limit) => {
  const all = (ctx.api as PlatformAPI).customers_list('t_demo', 100);
  return all
    .filter((c) => c.name.includes(query) || c.email.includes(query))
    .slice(0, limit)
    .map((c) => ({ id: c.id, label: `${c.name} <${c.email}>` }));
});

const registry = new ActionRegistry({
  idempotency: new MemoryIdempotencyStore(),
  confirmation: new MemoryConfirmationStore(),
  rateLimit: new MemoryRateLimiter(),
  loop: new MemoryLoopDetector(),
  neverList: defaultNeverList(),
  plans,
});
registry.register(listCustomers, inviteTeamMember, makeDisambiguateAction(disambig));

const ctx = {
  user: { id: 'u_demo', roles: ['admin'] },
  delegation: { via: 'ai_chat' as const, llm_model: 'mock' },
  trace_id: crypto.randomUUID(),
  api: platformAPI as PlatformAPI,
  audit,
  errors,
  currentTeam: () => 't_demo',
};

// ─── §18 demo: disambiguate first ────────────────────────────────────────────

console.log('═══ §18 Disambiguation ═══');
console.log('User asks: "把那个 alice 升级一下" — name is ambiguous');
const disambigResult = await registry.dispatch(
  'disambiguate',
  { domain: 'customer', query: 'alice', limit: 5 },
  ctx,
);
console.log('disambiguate →', JSON.stringify(disambigResult, null, 2));

// ─── §17 demo: propose → approve → execute ──────────────────────────────────

console.log('\n═══ §17 Plan & Checkpoint ═══');
console.log('AI proposes a 3-step plan…');

const plan = plans.propose(
  'u_demo',
  [
    { action: 'list_customers', input: { limit: 5 }, label: '清点当前客户' },
    {
      action: 'invite_team_member',
      input: { email: 'newhire1@acme.com', role: 'member' },
      label: '邀请新员工 1',
    },
    {
      action: 'invite_team_member',
      input: { email: 'newhire2@acme.com', role: 'member' },
      label: '邀请新员工 2',
    },
  ],
  '计划清点客户列表，然后邀请 2 名新员工以普通成员身份加入团队。',
);

console.log('\n┌─ Plan proposed to user ──────────');
console.log(`│ Plan ID: ${plan.id}`);
console.log(`│ Summary: ${plan.summary}`);
plan.steps.forEach((s, i) => {
  console.log(`│   ${i + 1}. ${s.label ?? s.action} — ${s.action}(${JSON.stringify(s.input)})`);
});
console.log(`│ [✓ 同意整个计划]   [✗ 拒绝]`);
console.log('└──────────────────────────────────');

console.log('\n[user clicked 同意整个计划]');
plans.approve(plan.id, 'u_demo');

console.log('\nExecuting plan…\n');
await plans.execute(plan.id, registry, ctx, async (event) => {
  switch (event.type) {
    case 'step_started':
      console.log(`▶ Step ${event.index + 1}: ${event.step.label ?? event.step.action}`);
      break;
    case 'step_completed':
      console.log(`✓ Step ${event.index + 1} done`);
      break;
    case 'step_failed':
      console.log(`✗ Step ${event.index + 1} failed: ${JSON.stringify(event.error)}`);
      break;
    case 'plan_completed':
      console.log(`\n🎉 Plan ${event.plan_id} completed`);
      break;
    case 'plan_aborted':
      console.log(`\n⛔ Plan ${event.plan_id} aborted: ${event.reason}`);
      break;
  }
});

console.log('\nNote: the 2 invite steps did NOT trigger per-step confirmation,');
console.log('because the plan-level approval covered them. Dangerous steps');
console.log('(if marked) would still re-prompt — that is the §17 guarantee.');
