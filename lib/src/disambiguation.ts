/**
 * Disambiguation — see STANDARD.md §18
 *
 * Two coexisting mechanisms:
 *
 *   1. Reactive — any Action handler can throw NEEDS_CLARIFICATION
 *      (already in errors.ts) with a question + candidates.
 *
 *   2. Proactive — a standard `disambiguate(domain, query)` action lets
 *      the LLM resolve before calling the real action. Domains plug in
 *      search functions; this file makes registering them ergonomic.
 *
 *      Prompt the model with:
 *        "If a parameter is ambiguous, first call disambiguate(domain, query)
 *         to surface candidates. Do not guess."
 */

import { z } from 'zod';
import { defineAction } from './define-action.js';
import type { Context } from './types.js';
import { errors } from './errors.js';

export interface Candidate {
  id: string;
  label: string;
  hint?: string;
}

export type DisambiguationSearch = (
  ctx: Context,
  query: string,
  limit: number,
) => Promise<Candidate[]>;

/**
 * Registry that maps a domain name to its search function.
 * Platforms register one entry per "kind of thing users refer to by name":
 * customer, member, project, document, etc.
 */
export class DisambiguationProviders {
  private providers = new Map<string, DisambiguationSearch>();

  register(domain: string, search: DisambiguationSearch): this {
    this.providers.set(domain, search);
    return this;
  }

  knownDomains(): string[] {
    return [...this.providers.keys()];
  }

  get(domain: string): DisambiguationSearch | undefined {
    return this.providers.get(domain);
  }
}

/**
 * Build the standard `disambiguate` action from a registered provider set.
 * Mount on the registry like any other action.
 */
export function makeDisambiguateAction(providers: DisambiguationProviders) {
  return defineAction({
    name: 'disambiguate',
    version: '1.0',
    description:
      '当参数有歧义时先调用此工具列出候选，不要猜。例如用户说"那个 John"，先用 disambiguate("customer","John") 找候选再问用户。',
    domain: '_meta',
    risk: 'read',
    aiInvocable: true,

    input: z.object({
      domain: z
        .string()
        .describe(`要消解的域，可选值取决于平台注册（如 customer / member / project）`),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional().default(5),
    }),

    output: z.object({
      domain: z.string(),
      query: z.string(),
      candidates: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          hint: z.string().optional(),
        }),
      ),
      question: z.string(),
    }),

    examples: [
      {
        prompt: '把那个 John 升成管理员',
        input: { domain: 'customer', query: 'John', limit: 5 },
      },
      {
        prompt: '找一下叫小李的客户',
        input: { domain: 'customer', query: '小李', limit: 5 },
      },
    ],

    async handler(ctx, input) {
      const search = providers.get(input.domain);
      if (!search) {
        throw errors.invalidInput(
          `Unknown disambiguation domain "${input.domain}". Known: ${providers
            .knownDomains()
            .join(', ')}`,
          'domain',
        );
      }
      const candidates = await search(ctx, input.query, input.limit);
      return {
        domain: input.domain,
        query: input.query,
        candidates,
        question:
          candidates.length === 0
            ? `没有找到匹配 "${input.query}" 的 ${input.domain}，请用户提供更精确的信息。`
            : candidates.length === 1
              ? `找到唯一匹配：${candidates[0].label}。如果是这个请直接继续。`
              : `找到 ${candidates.length} 个匹配 "${input.query}" 的 ${input.domain}，请用户确认要哪一个。`,
      };
    },
  });
}

/**
 * Recommended system-prompt fragment — pair with toClaudeTools() output.
 */
export const DISAMBIGUATION_PROMPT_FRAGMENT = `\
When a parameter could refer to multiple things (e.g. "that John", "the
project we discussed"), do not guess. First call \`disambiguate(domain, query)\`
to list candidates and ask the user to pick. Only after the user resolves the
ambiguity should you call the real action with the chosen ID.
`;
