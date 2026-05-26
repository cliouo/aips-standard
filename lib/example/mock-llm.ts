/**
 * Mock LLM — deterministic intent matcher for the demo.
 *
 * Real implementation: swap for an Anthropic client. The interface here
 * matches what evals.ts and the chat loop need, so the rest of the demo
 * is identical regardless of which "brain" sits behind it.
 */

import type { LLMInvocation, LLMInvoker } from '../src/index.js';

/**
 * Toy intent matcher. Looks at the user prompt and picks a tool based on
 * keyword presence. Good enough to exercise the eval harness and the
 * tool_use loop deterministically.
 */
export const mockInvoke: LLMInvoker = async ({ user, tools }) => {
  const text = user.toLowerCase();
  const toolNames = new Set(tools.map((t) => t.name));

  // Negative cases first — refuse dangerous phrasings
  if (/(清空|全部删|delete all|清除所有)/.test(text)) {
    return {
      refused: true,
      raw_text: '此操作非常危险，我不会执行。请通过平台管理界面手动处理。',
    };
  }

  // Match invite intent
  if (/(邀请|加成员|invite|加.*团队)/.test(text) && toolNames.has('invite_team_member')) {
    const emailMatch = text.match(/[\w.+-]+@[\w.-]+\.\w+/);
    let role: 'admin' | 'member' | 'viewer' = 'member';
    if (/(管理员|admin)/.test(text)) role = 'admin';
    else if (/(viewer|只读|观察)/.test(text)) role = 'viewer';

    return {
      tool_name: 'invite_team_member',
      tool_input: emailMatch
        ? { email: emailMatch[0], role }
        : { role },
    };
  }

  // Match report-generation intent (§24 Generative Action)
  if (/(周报|月报|报告|总结|report|summary)/.test(text) && toolNames.has('generate_report')) {
    let period: 'week' | 'month' | 'quarter' = 'week';
    if (/(月|month)/.test(text)) period = 'month';
    else if (/(季|quarter)/.test(text)) period = 'quarter';
    return {
      tool_name: 'generate_report',
      tool_input: { period },
    };
  }

  // Match list intent
  if (
    /(列表|看.*客户|客户列表|前\s*\d+\s*个?\s*客户|\d+\s*个?\s*客户|list|customers?)/.test(text) &&
    toolNames.has('list_customers')
  ) {
    const limitMatch = text.match(/前\s*(\d+)|limit\s+(\d+)|(\d+)\s*个/);
    const limit = limitMatch
      ? Number(limitMatch[1] || limitMatch[2] || limitMatch[3])
      : 20;
    return {
      tool_name: 'list_customers',
      tool_input: { limit },
    };
  }

  return { raw_text: '抱歉，我不知道怎么处理这个请求。' } satisfies LLMInvocation;
};
