/**
 * Read action — no confirmation needed.
 */

import { z } from 'zod';
import { defineAction } from '../../src/index.js';
import type { PlatformAPI } from '../platform-api.js';

export const listCustomers = defineAction({
  name: 'list_customers',
  version: '1.0',
  description: '列出当前团队的客户。用户问"看看客户"、"客户列表"时使用。',
  domain: 'customer',
  risk: 'read',
  owner: 'team-platform@acme.com',

  input: z.object({
    limit: z.number().int().min(1).max(100).optional().default(20),
  }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        email: z.string(),
      }),
    ),
    total: z.number(),
    truncated: z.boolean(),
  }),

  examples: [
    { prompt: '看一下客户列表', input: { limit: 20 } },
    { prompt: '前 5 个客户是谁', input: { limit: 5 } },
  ],

  async handler(ctx, input) {
    const team_id = ctx.currentTeam?.() ?? 't_demo';
    const api = ctx.api as PlatformAPI;
    const total = api.customer_count(team_id);
    const items = api.customers_list(team_id, input.limit ?? 20);
    return {
      items: items.map((c) => ({ id: c.id, name: c.name, email: c.email })),
      total,
      truncated: items.length < total,
    };
  },
});
