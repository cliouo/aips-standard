/**
 * defineAction() — see STANDARD.md §4
 *
 * Validates spec at registration time. Returns an Action object that the
 * registry can mount. Business logic stays in the handler; everything else
 * (auth, confirmation, idempotency, audit, rate-limit, masking) runs as
 * middleware around it inside the dispatcher.
 */

import type { ZodTypeAny } from 'zod';
import type { Action, ActionSpec } from './types.js';

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const VERSION_PATTERN = /^\d+\.\d+$/;
const MAX_DESCRIPTION_LEN = 200;

function validateSpec(spec: ActionSpec): void {
  if (!NAME_PATTERN.test(spec.name)) {
    throw new Error(
      `[Refract] Invalid action name "${spec.name}" — must match ${NAME_PATTERN} (verb_noun, snake_case)`,
    );
  }
  if (!VERSION_PATTERN.test(spec.version)) {
    throw new Error(
      `[Refract] Invalid version "${spec.version}" for ${spec.name} — must match ${VERSION_PATTERN}`,
    );
  }
  if (spec.description.length === 0 || spec.description.length > MAX_DESCRIPTION_LEN) {
    throw new Error(
      `[Refract] Description for ${spec.name} must be 1-${MAX_DESCRIPTION_LEN} chars (got ${spec.description.length})`,
    );
  }

  // §6: write & dangerous actions must declare confirmation explicitly
  if (spec.risk === 'dangerous' && spec.requiresConfirmation === false) {
    throw new Error(
      `[Refract] Dangerous action ${spec.name} cannot opt out of confirmation`,
    );
  }
  if (spec.risk === 'write' && spec.requiresConfirmation === undefined) {
    throw new Error(
      `[Refract] Write action ${spec.name} must explicitly set requiresConfirmation (true or false)`,
    );
  }
  if (spec.risk === 'read' && spec.requiresConfirmation) {
    throw new Error(
      `[Refract] Read action ${spec.name} should not require confirmation`,
    );
  }

  // §6: confirmation requires a summary renderer
  if (spec.requiresConfirmation && !spec.summary) {
    throw new Error(
      `[Refract] Action ${spec.name} requiresConfirmation=true but no summary() provided`,
    );
  }

  // §15: deprecated/removed sanity
  if (spec.removedAt && !spec.deprecatedAt) {
    throw new Error(
      `[Refract] Action ${spec.name} has removedAt but no deprecatedAt`,
    );
  }

  // §24: a deterministic action's output is system fact, not AI-generated.
  // Declaring provenance 'generated' without kind 'generative' is a mislabel.
  if (spec.kind !== 'generative' && spec.provenance === 'generated') {
    throw new Error(
      `[Refract] Action ${spec.name} declares provenance 'generated' but is not generative — set kind: 'generative', or pick provenance 'retrieved' / 'mixed'`,
    );
  }
}

export function defineAction<
  TI extends ZodTypeAny,
  TO extends ZodTypeAny,
  API = unknown,
>(spec: ActionSpec<TI, TO, API>): Action<TI, TO, API> {
  // Default aiInvocable to true (the whole point) — but you can set false
  // to expose an action over REST only, never to AI.
  spec.aiInvocable = spec.aiInvocable !== false;

  // §24 — default execution shape + output provenance
  spec.kind = spec.kind ?? 'deterministic';
  spec.provenance =
    spec.provenance ?? (spec.kind === 'generative' ? 'generated' : 'retrieved');

  validateSpec(spec as unknown as ActionSpec);

  return { spec };
}
