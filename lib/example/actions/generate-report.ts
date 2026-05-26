/**
 * Generative Action — STANDARD.md §24.
 *
 * The handler runs a fixed LLM pipeline internally to produce a document-
 * shaped result. The AI is a step *inside* the action, hidden behind the
 * same typed contract as any other Action — the dispatcher, audit,
 * never-list, confirmation etc. treat it identically. Two §24 properties
 * are what make it a Generative Action rather than a plain read:
 *
 *   kind: 'generative'      → consumers know to expect latency + non-determinism
 *   provenance: 'generated' → output is AI-written, NOT system fact. Surfaced
 *                             on the REST `X-Refract-Provenance` header, the
 *                             audit record, and the discovery listing so the
 *                             UI can label it (§24 / §26).
 *
 * Same shape can run in either operator stance (§25): from the chat box
 * (autopilot → inline card) or from a "✨ generate" button on a reporting
 * page (copilot → pre-filled panel). The action doesn't change.
 */

import { z } from 'zod';
import { defineAction } from '../../src/index.js';
import type { PlatformAPI } from '../platform-api.js';

export const generateReport = defineAction({
  name: 'generate_report',
  version: '1.0',
  description: '为团队生成一段活动总结报告。用户说"生成周报"、"总结一下本月情况"时使用。',
  domain: 'reporting',
  risk: 'read', // 生成内容、不写数据 → 无需确认
  kind: 'generative', // §24 — handler 内部跑固定 LLM 流水线
  // provenance 默认 'generated'（输出是 AI 写的，非系统事实）
  idempotent: false, // §24 — 同输入产出可变
  owner: 'team-platform@acme.com',

  input: z.object({
    period: z.enum(['week', 'month', 'quarter']).optional().default('week'),
    focus: z.string().max(120).optional(),
  }),
  output: z.object({
    title: z.string(),
    summary_markdown: z.string(),
    highlights: z.array(z.string()),
    generated_at: z.string(),
  }),

  examples: [
    { prompt: '生成本周周报', input: { period: 'week' } },
    { prompt: '总结一下这个月的情况', input: { period: 'month' } },
  ],

  async handler(ctx, input) {
    const team_id = ctx.currentTeam?.() ?? 't_demo';
    const api = ctx.api as PlatformAPI;

    // 1) 取真实数据（系统事实）
    const customerCount = api.customer_count(team_id);

    // 2) 喂给 LLM 生成叙述。这里用确定性 stand-in 代替真实模型调用；
    //    生产实现换成 Anthropic 调用即可，下游 schema 不变。
    //    §10 Spotlighting + §22 redaction 应在此前套到 input.focus 这类自由文本上。
    const report = mockGenerate(input.period, input.focus, customerCount);

    return { ...report, generated_at: new Date().toISOString() };
  },
});

const PERIOD_LABEL: Record<'week' | 'month' | 'quarter', string> = {
  week: '本周',
  month: '本月',
  quarter: '本季度',
};

/**
 * Stand-in for a real LLM call. A production handler sends a prompt to Claude
 * here; the result shape is identical, so swapping the brain changes nothing
 * downstream. Kept deterministic so the demo runs with no API key.
 */
function mockGenerate(
  period: 'week' | 'month' | 'quarter',
  focus: string | undefined,
  customerCount: number,
) {
  const label = PERIOD_LABEL[period];
  const focusLine = focus ? `（聚焦：${focus}）` : '';
  return {
    title: `${label}团队活动报告${focusLine}`,
    summary_markdown:
      `## ${label}小结\n\n` +
      `当前团队共有 **${customerCount}** 位客户。${label}整体运营平稳，` +
      `建议持续关注客户活跃度与跟进节奏。\n`,
    highlights: [
      `客户总数：${customerCount}`,
      `周期：${label}`,
      ...(focus ? [`关注重点：${focus}`] : []),
    ],
  };
}
