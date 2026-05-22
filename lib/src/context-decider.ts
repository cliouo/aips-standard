/**
 * Context decider — see STANDARD.md §21 surface A
 *
 * Given (user, route, query), decide which Cards (domains) and which
 * Actions are exposed to the LLM for this turn. The same function powers:
 *
 *   - The chat endpoint: builds the tool list for Claude tool_use
 *   - The "context indicator" endpoint: shows the user what's active
 *
 * Two computations from one source of truth → guaranteed they agree.
 */

import type { ActionRegistry } from './registry.js';

export interface ContextRequest {
  user: { id: string; roles: string[] };
  /** Pathname like /team/123/members — used for route-driven cards */
  route?: string;
  /** Optional: the user's most recent query, for intent-driven cards */
  query?: string;
}

export interface ActiveContext {
  domains: string[];
  actions: Array<{
    name: string;
    description: string;
    risk: string;
    domain: string;
    requires_confirmation: boolean;
  }>;
  /** What the LLM will see (mirror of the system prompt context) */
  system_prompt_fragments: string[];
}

export interface RouteRule {
  /** Route prefix or regex match */
  match: string | RegExp;
  /** Domains to activate when this rule matches */
  domains: string[];
}

export interface RoleRule {
  role: string;
  domains: string[];
}

export class ContextDecider {
  private routeRules: RouteRule[] = [];
  private roleRules: RoleRule[] = [];
  private alwaysOn = new Set<string>();
  private extraPromptFragments: string[] = [];

  /** Domains always exposed regardless of route/role */
  always(...domains: string[]): this {
    for (const d of domains) this.alwaysOn.add(d);
    return this;
  }

  /** Add a route → domains rule */
  onRoute(match: string | RegExp, ...domains: string[]): this {
    this.routeRules.push({ match, domains });
    return this;
  }

  /** Add a role → domains rule */
  onRole(role: string, ...domains: string[]): this {
    this.roleRules.push({ role, domains });
    return this;
  }

  /** Prompt fragments to inject (e.g. injection defense, disambig hint) */
  addSystemPromptFragment(text: string): this {
    this.extraPromptFragments.push(text);
    return this;
  }

  /** Resolve which domains are active for a given request */
  resolveDomains(req: ContextRequest): string[] {
    const out = new Set<string>(this.alwaysOn);

    for (const r of this.routeRules) {
      const route = req.route ?? '';
      const matched =
        typeof r.match === 'string' ? route.startsWith(r.match) : r.match.test(route);
      if (matched) for (const d of r.domains) out.add(d);
    }

    for (const r of this.roleRules) {
      if (req.user.roles.includes(r.role)) for (const d of r.domains) out.add(d);
    }

    return [...out];
  }

  /** Resolve the full active context — for both the chat endpoint and the UI */
  resolve(req: ContextRequest, registry: ActionRegistry): ActiveContext {
    const domains = this.resolveDomains(req);
    const actions = registry
      .listAIInvocable()
      .filter((a) => domains.includes(a.spec.domain ?? 'misc'))
      .map((a) => ({
        name: a.spec.name,
        description: a.spec.description,
        risk: a.spec.risk,
        domain: a.spec.domain ?? 'misc',
        requires_confirmation: !!a.spec.requiresConfirmation,
      }));

    return {
      domains,
      actions,
      system_prompt_fragments: this.extraPromptFragments.slice(),
    };
  }
}
