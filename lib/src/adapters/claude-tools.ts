/**
 * Claude tool_use adapter — projects the registry into the tool list format
 * accepted by Anthropic's Messages API.
 *
 * Type 1 (in-platform AI) uses this to build the `tools` array each turn.
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ActionRegistry } from '../registry.js';

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ClaudeToolFilter {
  /** Only include actions whose domain is in this list */
  domains?: string[];
  /** Exclude high-risk actions (typically when AI confidence is low) */
  excludeRisks?: Array<'read' | 'write' | 'dangerous'>;
  /** Always include these names regardless of domain filter */
  alwaysInclude?: string[];
}

/**
 * Build Claude tool definitions from the registry.
 *
 * Filter by domain to implement route-driven context injection (STANDARD §16):
 * the chat endpoint knows the user's current page → picks a domain list →
 * passes only those tools to Claude.
 */
export function toClaudeTools(
  registry: ActionRegistry,
  filter: ClaudeToolFilter = {},
): ClaudeTool[] {
  const actions = registry.listAIInvocable().filter((a) => {
    if (filter.alwaysInclude?.includes(a.spec.name)) return true;
    if (filter.excludeRisks?.includes(a.spec.risk)) return false;
    if (filter.domains && !filter.domains.includes(a.spec.domain ?? 'misc')) {
      return false;
    }
    return true;
  });

  return actions.map((a) => ({
    name: a.spec.name,
    description: buildDescription(a.spec),
    input_schema: zodToJsonSchema(a.spec.input, {
      $refStrategy: 'none',
      target: 'jsonSchema7',
    }) as Record<string, unknown>,
  }));
}

function buildDescription(spec: { description: string; risk: string; deprecatedAt?: string }) {
  let desc = spec.description;
  if (spec.risk === 'dangerous') desc += ' [HIGH RISK]';
  if (spec.deprecatedAt) desc += ` [DEPRECATED ${spec.deprecatedAt}]`;
  return desc;
}

// ─── Skill markdown generator (Anthropic Agent Skills v1 compliant) ─────────
// Generates a SKILL.md fragment per domain — for type 2 (Claude Code etc.)
// See https://agentskills.io/specification for the v1 spec.

/** Agent Skills v1: name must match this regex (1-64 chars, no leading/trailing/consecutive hyphens) */
const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SKILL_NAME_MAX = 64;
const SKILL_DESCRIPTION_MAX = 1024;

export interface SkillMarkdownOptions {
  vendorPrefix: string;
  description?: string;
  /** SPDX license identifier (e.g. "Apache-2.0", "MIT"). Optional per spec. */
  license?: string;
  /** Free-text compatibility note, ≤500 chars per spec. */
  compatibility?: string;
}

/** Validate an Agent Skills v1 name. Throws on violation. */
export function validateSkillName(name: string): void {
  if (name.length === 0 || name.length > SKILL_NAME_MAX) {
    throw new Error(
      `[Refract] Skill name must be 1-${SKILL_NAME_MAX} chars, got ${name.length} ("${name}")`,
    );
  }
  if (name.includes('--')) {
    throw new Error(`[Refract] Skill name "${name}" contains consecutive hyphens (forbidden by Agent Skills v1)`);
  }
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(
      `[Refract] Skill name "${name}" violates Agent Skills v1 — must match ${SKILL_NAME_RE}`,
    );
  }
}

export function toSkillMarkdown(
  registry: ActionRegistry,
  domain: string,
  opts: SkillMarkdownOptions = { vendorPrefix: 'acme' },
): string {
  const actions = registry.byDomain().get(domain) ?? [];
  if (actions.length === 0) return '';

  const aiActions = actions.filter((a) => a.spec.aiInvocable !== false);

  const allowedTools = aiActions
    .map((a) => `Bash(${opts.vendorPrefix} ${a.spec.name.replace(/_/g, '-')} *)`)
    .join(' ');

  const skillName = `${opts.vendorPrefix}-${domain}`;
  validateSkillName(skillName);

  let description = opts.description ?? `${domain} 域的常用操作`;
  if (description.length > SKILL_DESCRIPTION_MAX) {
    description = description.slice(0, SKILL_DESCRIPTION_MAX - 1) + '…';
  }

  const lines = [
    '---',
    `name: ${skillName}`,
    `description: ${description}`,
    `allowed-tools: ${allowedTools}`,
  ];
  if (opts.license) lines.push(`license: ${opts.license}`);
  if (opts.compatibility) {
    const c =
      opts.compatibility.length > 500
        ? opts.compatibility.slice(0, 499) + '…'
        : opts.compatibility;
    lines.push(`compatibility: ${c}`);
  }
  lines.push(
    '---',
    '',
    `# ${opts.vendorPrefix} · ${domain}`,
    '',
    `通过 \`${opts.vendorPrefix}\` CLI 操作 ${domain} 资源。写操作会在 Claude Code 中弹确认。`,
    '',
    '## 常用命令',
    '',
  );

  for (const a of aiActions) {
    const cmd = a.spec.name.replace(/_/g, '-');
    const risk = a.spec.risk === 'write' ? ' *(写操作，需确认)*' : '';
    lines.push(`- \`${opts.vendorPrefix} ${cmd}\`${risk} — ${a.spec.description}`);
  }

  lines.push(
    '',
    '完整参数请跑 `' + opts.vendorPrefix + ' <command> --help`。',
    '',
  );

  return lines.join('\n');
}

// ─── CLI spec generator ──────────────────────────────────────────────────────
// Produces a descriptor that the CLI binary can consume to render subcommands.
// (The actual CLI is shipped separately, usually Go; this just describes the
// command surface so the CLI build can codegen its argument parsers.)

export interface CLICommandSpec {
  name: string;             // kebab-case
  description: string;
  domain: string;
  risk: string;
  endpoint: string;         // POST /api/v1/actions/<name>
  flags: Array<{
    name: string;           // kebab-case
    type: 'string' | 'number' | 'boolean' | 'array';
    required: boolean;
    description?: string;
    enum?: string[];
  }>;
}

export function toCLISpec(registry: ActionRegistry): CLICommandSpec[] {
  return registry.listAIInvocable().map((a) => {
    const schema = zodToJsonSchema(a.spec.input, {
      $refStrategy: 'none',
      target: 'jsonSchema7',
    }) as any;

    const props = schema.properties ?? {};
    const required: string[] = schema.required ?? [];

    const flags = Object.entries<any>(props).map(([key, prop]) => ({
      name: key.replace(/_/g, '-'),
      type: jsonTypeToFlagType(prop.type),
      required: required.includes(key),
      description: prop.description,
      enum: prop.enum,
    }));

    return {
      name: a.spec.name.replace(/_/g, '-'),
      description: a.spec.description,
      domain: a.spec.domain ?? 'misc',
      risk: a.spec.risk,
      endpoint: `/api/v1/actions/${a.spec.name.replace(/_/g, '-')}`,
      flags,
    };
  });
}

function jsonTypeToFlagType(t: string): CLICommandSpec['flags'][number]['type'] {
  if (t === 'integer' || t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'array') return 'array';
  return 'string';
}
