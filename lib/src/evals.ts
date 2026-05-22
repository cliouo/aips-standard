/**
 * Eval harness — see STANDARD.md §19
 *
 * Validates that the LLM picks the right Action with the right args
 * given the natural-language `examples` declared on each Action spec.
 *
 * The harness is LLM-agnostic: callers inject an `invoke()` that takes
 * (system, user, tools) and returns the model's first tool_use block.
 * That keeps this file dependency-free; real Claude integration lives
 * outside.
 */

import type { ActionRegistry } from './registry.js';
import type { ClaudeTool } from './adapters/claude-tools.js';
import { toClaudeTools } from './adapters/claude-tools.js';

export interface LLMInvocation {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  refused?: boolean;
  raw_text?: string;
}

export type LLMInvoker = (params: {
  system: string;
  user: string;
  tools: ClaudeTool[];
}) => Promise<LLMInvocation>;

export interface EvalCase {
  id: string;
  prompt: string;
  expect_tool?: string;
  expect_args?: Record<string, unknown>;
  /** Tool MUST NOT be one of these */
  expect_no_tool_call_in?: string[];
}

export interface EvalResult {
  caseId: string;
  prompt: string;
  passed: boolean;
  reason?: string;
  observed: LLMInvocation;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  results: EvalResult[];
}

const DEFAULT_SYSTEM = `\
You are an AI assistant for a platform. Use the provided tools to fulfill
user requests. If a request is dangerous, ambiguous, or out of scope,
do not call a tool — explain in plain text instead.
`;

/**
 * Build eval cases from an Action's declared examples.
 * Each example becomes a positive case ("this prompt → this tool with these args").
 */
export function casesFromExamples(registry: ActionRegistry): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const a of registry.list()) {
    if (a.spec.aiInvocable === false) continue;
    const examples = a.spec.examples ?? [];
    for (let i = 0; i < examples.length; i++) {
      cases.push({
        id: `${a.spec.name}#${i}`,
        prompt: examples[i].prompt,
        expect_tool: a.spec.name,
        expect_args: examples[i].input as Record<string, unknown>,
      });
    }
  }
  return cases;
}

function argsMatch(
  expected: Record<string, unknown> | undefined,
  observed: Record<string, unknown> | undefined,
): { ok: boolean; reason?: string } {
  if (!expected) return { ok: true };
  if (!observed) return { ok: false, reason: 'no tool_input' };
  for (const [k, v] of Object.entries(expected)) {
    const got = observed[k];
    if (JSON.stringify(got) !== JSON.stringify(v)) {
      return { ok: false, reason: `arg "${k}" expected ${JSON.stringify(v)}, got ${JSON.stringify(got)}` };
    }
  }
  return { ok: true };
}

export async function runEvals(
  registry: ActionRegistry,
  cases: EvalCase[],
  invoke: LLMInvoker,
  opts: { system?: string } = {},
): Promise<EvalSummary> {
  const tools = toClaudeTools(registry);
  const results: EvalResult[] = [];

  for (const c of cases) {
    const observed = await invoke({
      system: opts.system ?? DEFAULT_SYSTEM,
      user: c.prompt,
      tools,
    });

    let passed = true;
    let reason: string | undefined;

    if (c.expect_no_tool_call_in) {
      if (observed.tool_name && c.expect_no_tool_call_in.some((p) =>
        p.endsWith('_*')
          ? observed.tool_name!.startsWith(p.slice(0, -2))
          : observed.tool_name === p,
      )) {
        passed = false;
        reason = `should not have called ${observed.tool_name}`;
      }
    }

    if (c.expect_tool && observed.tool_name !== c.expect_tool) {
      passed = false;
      reason = `expected tool ${c.expect_tool}, got ${observed.tool_name ?? '<none>'}`;
    }

    if (passed && c.expect_args) {
      const m = argsMatch(c.expect_args, observed.tool_input);
      if (!m.ok) {
        passed = false;
        reason = m.reason;
      }
    }

    results.push({ caseId: c.id, prompt: c.prompt, passed, reason, observed });
  }

  return {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    results,
  };
}

/**
 * Pretty-print an eval summary to stdout. CI-friendly:
 * exits with code 1 if any case failed.
 */
export function printSummary(summary: EvalSummary): void {
  const FAIL = '✗';
  const PASS = '✓';
  for (const r of summary.results) {
    const sym = r.passed ? PASS : FAIL;
    // eslint-disable-next-line no-console
    console.log(`${sym} ${r.caseId}  "${r.prompt}"`);
    if (!r.passed) console.log(`    → ${r.reason}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n${summary.passed}/${summary.total} passed`);
}
