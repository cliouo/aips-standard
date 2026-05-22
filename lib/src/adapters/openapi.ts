/**
 * OpenAPI 3.1 export — see STANDARD.md §20 "可移植性"
 *
 * From the same Action registry that powers REST / Claude tool_use /
 * SKILL.md / CLI spec, emit an OpenAPI 3.1 document. Useful for:
 *
 *   - Generating typed SDKs in any language (openapi-generator, oapi-codegen,
 *     orval, ...)
 *   - Importing into Postman / Insomnia / Stoplight for exploration
 *   - Wiring up gateways (Kong, APISIX) that consume OpenAPI
 *
 * The emitted spec encodes:
 *   - One POST /api/v1/actions/<name> per Action
 *   - Common RefractError schema referenced by every 4xx/5xx response
 *   - PENDING_CONFIRMATION as a documented 409 alternative for write ops
 *   - X-Deprecated header on deprecated operations
 *   - Idempotency-Key / X-Confirmation-Token headers
 *   - Components/schemas: ErrorBody + per-action input/output
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ActionRegistry } from '../registry.js';

export interface OpenAPIInfo {
  title: string;
  version: string;
  description?: string;
  servers?: Array<{ url: string; description?: string }>;
}

const ERROR_SCHEMA_NAME = 'RefractError';
const COMMON_ERROR_CODES = [
  ['400', 'INVALID_INPUT'],
  ['401', 'UNAUTHORIZED'],
  ['403', 'PERMISSION_DENIED'],
  ['404', 'NOT_FOUND'],
  ['409', 'CONFLICT'],
  ['422', 'NEEDS_CLARIFICATION'],
  ['429', 'RATE_LIMITED'],
  ['500', 'INTERNAL_ERROR'],
  ['503', 'UNAVAILABLE'],
] as const;

export function toOpenAPI(
  registry: ActionRegistry,
  info: OpenAPIInfo,
): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {
    [ERROR_SCHEMA_NAME]: errorSchema(),
  };

  for (const action of registry.list()) {
    const spec = action.spec;
    const path = `/api/v1/actions/${spec.name.replace(/_/g, '-')}`;
    const opId = spec.name;

    const inputSchemaName = pascalCase(spec.name) + 'Input';
    const outputSchemaName = pascalCase(spec.name) + 'Output';

    schemas[inputSchemaName] = stripDraft(zodToJsonSchema(spec.input, {
      $refStrategy: 'none',
      target: 'jsonSchema7',
    }) as Record<string, any>);
    schemas[outputSchemaName] = stripDraft(zodToJsonSchema(spec.output, {
      $refStrategy: 'none',
      target: 'jsonSchema7',
    }) as Record<string, any>);

    const responses: Record<string, unknown> = {
      '200': {
        description: 'Action completed successfully',
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${outputSchemaName}` },
          },
        },
      },
    };

    if (spec.requiresConfirmation) {
      responses['409'] = {
        description:
          'PENDING_CONFIRMATION — first call to a write action returns this. ' +
          'Resend with X-Confirmation-Token to execute.',
        content: {
          'application/json': {
            schema: {
              allOf: [
                { $ref: `#/components/schemas/${ERROR_SCHEMA_NAME}` },
                {
                  type: 'object',
                  properties: {
                    confirmation_token: { type: 'string' },
                    summary: { type: 'string' },
                    expires_at: { type: 'string', format: 'date-time' },
                  },
                  required: ['confirmation_token', 'summary'],
                },
              ],
            },
          },
        },
      };
    }

    for (const [status, code] of COMMON_ERROR_CODES) {
      if (responses[status]) continue;
      responses[status] = {
        description: code,
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${ERROR_SCHEMA_NAME}` },
          },
        },
      };
    }

    const parameters: Array<Record<string, unknown>> = [
      {
        name: 'Idempotency-Key',
        in: 'header',
        required: spec.risk !== 'read',
        schema: { type: 'string', format: 'uuid' },
        description: 'Client-generated UUID for §7 idempotency. Required on writes.',
      },
    ];
    if (spec.requiresConfirmation) {
      parameters.push({
        name: 'X-Confirmation-Token',
        in: 'header',
        required: false,
        schema: { type: 'string' },
        description: 'Token returned by a prior 409 PENDING_CONFIRMATION response.',
      });
    }
    parameters.push(
      {
        name: 'X-Refract-Via',
        in: 'header',
        required: false,
        schema: { type: 'string', enum: ['ai_chat', 'cli', 'mcp', 'direct'] },
        description: '§5 delegation channel.',
      },
      {
        name: 'X-Trace-Id',
        in: 'header',
        required: false,
        schema: { type: 'string' },
      },
    );

    const tags = [spec.domain ?? 'misc'];

    paths[path] = {
      post: {
        operationId: opId,
        summary: spec.description,
        description: longDescription(spec),
        tags,
        deprecated: !!spec.deprecatedAt,
        parameters,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${inputSchemaName}` },
            },
          },
        },
        responses,
        'x-aips': {
          risk: spec.risk,
          ai_invocable: spec.aiInvocable !== false,
          requires_confirmation: !!spec.requiresConfirmation,
          version: spec.version,
          deprecated_at: spec.deprecatedAt ?? null,
          removed_at: spec.removedAt ?? null,
        },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: info.title,
      version: info.version,
      description: info.description ?? 'Generated from Refract Action registry',
    },
    servers: info.servers ?? [{ url: '/' }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        SessionCookie: { type: 'apiKey', in: 'cookie', name: 'session' },
        BearerToken: { type: 'http', scheme: 'bearer' },
      },
    },
    security: [{ BearerToken: [] }, { SessionCookie: [] }],
    tags: deriveTags(registry),
  };
}

function deriveTags(registry: ActionRegistry) {
  const domains = new Set<string>();
  for (const a of registry.list()) domains.add(a.spec.domain ?? 'misc');
  return [...domains].sort().map((name) => ({ name }));
}

function pascalCase(s: string) {
  return s
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

function stripDraft(schema: Record<string, any>) {
  // Drop $schema field — OpenAPI 3.1 doesn't want it inline
  const { $schema, ...rest } = schema;
  return rest;
}

function longDescription(spec: import('../types.js').ActionSpec): string {
  const lines = [spec.description];
  if (spec.owner) lines.push(`Owner: ${spec.owner}.`);
  if (spec.rateLimit) {
    const r = spec.rateLimit;
    const parts = [];
    if (r.perUserPerHour) parts.push(`${r.perUserPerHour}/h`);
    if (r.perUserPerDay) parts.push(`${r.perUserPerDay}/day`);
    if (parts.length) lines.push(`Rate limit: ${parts.join(', ')} per user.`);
  }
  if (spec.deprecatedAt) {
    lines.push(`**DEPRECATED** since ${spec.deprecatedAt}.`);
    if (spec.replacedBy) lines.push(`Use \`${spec.replacedBy}\` instead.`);
  }
  return lines.join('\n\n');
}

function errorSchema() {
  return {
    type: 'object',
    required: ['error', 'message_for_user', 'message_for_ai', 'retryable'],
    properties: {
      error: {
        type: 'string',
        description: 'Stable error code — see STANDARD.md Appendix B',
      },
      message_for_user: { type: 'string' },
      message_for_ai: { type: 'string' },
      retryable: { type: 'boolean' },
      field: {
        type: 'string',
        description: 'Present on INVALID_INPUT: the offending field path',
      },
      retry_after: {
        type: 'integer',
        description: 'Present on RATE_LIMITED: seconds until allowed',
      },
    },
  };
}
