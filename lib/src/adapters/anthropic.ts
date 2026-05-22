/**
 * Anthropic SDK invoker — drop-in replacement for the mock LLM.
 *
 * Implements LLMInvoker so the eval harness and chat loop work identically
 * with a real Claude model. The only swap needed in user code:
 *
 *   - import { mockInvoke } from './mock-llm.js'
 *   + import { makeAnthropicInvoker } from '@refract/core/adapters/anthropic'
 *   + const invoke = makeAnthropicInvoker({ apiKey: process.env.ANTHROPIC_API_KEY! });
 *
 * Requires the @anthropic-ai/sdk peer dependency.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LLMInvocation, LLMInvoker } from '../evals.js';

export interface AnthropicInvokerOptions {
  apiKey?: string;
  /** Default: claude-opus-4-7 */
  model?: string;
  /** Default: 1024 */
  maxTokens?: number;
  /** Optional client override (for tests, alternate base URLs, etc.) */
  client?: Anthropic;
}

/**
 * Build an LLMInvoker that calls Claude.
 *
 * Returns the first tool_use block in the model's response (mirrors the
 * "first attempt" semantics the eval harness expects). For multi-turn
 * tool_use loops use the chat-loop demo as a template.
 */
export function makeAnthropicInvoker(opts: AnthropicInvokerOptions = {}): LLMInvoker {
  const client =
    opts.client ?? new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY });
  const model = opts.model ?? 'claude-opus-4-7';
  const maxTokens = opts.maxTokens ?? 1024;

  return async ({ system, user, tools }): Promise<LLMInvocation> => {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
      })),
      messages: [{ role: 'user', content: user }],
    });

    for (const block of response.content) {
      if (block.type === 'tool_use') {
        return {
          tool_name: block.name,
          tool_input: block.input as Record<string, unknown>,
        };
      }
    }

    // No tool — treat as refusal/text response
    const textBlock = response.content.find((b) => b.type === 'text');
    const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';
    return {
      refused: response.stop_reason === 'end_turn' && !text.match(/^(ok|sure|fine)/i),
      raw_text: text,
    };
  };
}
