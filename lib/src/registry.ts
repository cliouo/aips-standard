/**
 * Action registry — central index of all defineAction() products.
 *
 * Adapters (REST, Claude tools, CLI) read from this registry to project
 * their respective surface areas.
 */

import type { Action, Context } from './types.js';
import type { DispatcherDeps } from './dispatcher.js';
import { dispatch } from './dispatcher.js';
import { errors } from './errors.js';

export class ActionRegistry {
  private actions = new Map<string, Action>();

  constructor(private deps: DispatcherDeps) {}

  register(...actions: Array<Action<any, any, any>>): this {
    for (const action of actions) {
      const key = action.spec.name;
      if (this.actions.has(key)) {
        throw new Error(`[Refract] Action ${key} already registered`);
      }

      // §12 — registration-time lint: AI-invocable actions cannot match never-list
      if (this.deps.neverList && action.spec.aiInvocable !== false) {
        const hit = this.deps.neverList.check(key);
        if (hit) {
          throw new Error(
            `[Refract] Action "${key}" is on the never-list (${hit.reason}). ` +
              `Either rename it, set ai_invocable: false, or remove the never-list entry.`,
          );
        }
      }

      this.actions.set(key, action as Action);
    }
    return this;
  }

  get(name: string): Action | undefined {
    return this.actions.get(name);
  }

  list(): Action[] {
    return [...this.actions.values()];
  }

  /** Actions exposed to AI clients (excludes ai_invocable: false) */
  listAIInvocable(): Action[] {
    return this.list().filter((a) => a.spec.aiInvocable !== false);
  }

  /** Group by domain for skill/card generation */
  byDomain(): Map<string, Action[]> {
    const out = new Map<string, Action[]>();
    for (const a of this.list()) {
      const domain = a.spec.domain ?? 'misc';
      const bucket = out.get(domain) ?? [];
      bucket.push(a);
      out.set(domain, bucket);
    }
    return out;
  }

  /** Execute an action by name through the full middleware chain */
  async dispatch(name: string, input: unknown, ctx: Context): Promise<unknown> {
    const action = this.actions.get(name);
    if (!action) throw errors.notFound(`Action "${name}"`);
    return dispatch(action, input, ctx, this.deps);
  }
}
