/**
 * Write action — requires confirmation.
 *
 * Demonstrates:
 *   - composed business logic (membership check + invite create + audit)
 *   - typed errors using ctx.errors
 *   - summary() for the §6 confirmation UX
 */

import { z } from 'zod';
import { defineAction } from '../../src/index.js';
import type { PlatformAPI } from '../platform-api.js';

const Input = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member', 'viewer']),
});
type Input = z.infer<typeof Input>;

export const inviteTeamMember = defineAction({
  name: 'invite_team_member',
  version: '1.0',
  description: '邀请新成员加入当前团队并发送邀请邮件。用户说"邀请 X"、"加成员"时使用。',
  domain: 'team',
  risk: 'write',
  requiresConfirmation: true,
  owner: 'team-platform@acme.com',
  rateLimit: { perUserPerHour: 20 },

  input: Input,
  output: z.object({
    invite_id: z.string(),
    status: z.enum(['sent', 'queued']),
  }),

  summary: (input) =>
    `将邀请 ${input.email} 以 ${input.role} 身份加入团队。会发送邀请邮件。`,

  examples: [
    {
      prompt: '邀请 alice@example.com 当管理员',
      input: { email: 'alice@example.com', role: 'admin' },
    },
    {
      prompt: '把 bob@example.com 加到团队里当普通成员',
      input: { email: 'bob@example.com', role: 'member' },
    },
  ],

  async handler(ctx, input) {
    const team_id = ctx.currentTeam?.() ?? 't_demo';
    const api = ctx.api as PlatformAPI;

    if (api.users_is_member_of(team_id, input.email)) {
      throw ctx.errors.conflict(`${input.email} 已是团队成员`);
    }

    const invite = api.invites_create(team_id, input.email, input.role);

    return { invite_id: invite.id, status: invite.status };
  },

  // §21-B — undo by revoking the invite. The activity history UI will
  // show an "undo" button on entries that completed successfully.
  async undo(_ctx, { result }) {
    // Real impl: call api.invites_revoke(result.invite_id). For the demo
    // we just log — the audit record proves the undo was attempted.
    // eslint-disable-next-line no-console
    console.log(`[undo] revoking invite ${result.invite_id}`);
  },
});
