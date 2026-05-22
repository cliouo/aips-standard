/**
 * Fake "Acme platform" REST API client.
 *
 * In a real project this would be your existing service layer — wrapping
 * Postgres, Redis, third-party calls etc. The Action handlers compose
 * these into business operations.
 */

export interface Customer {
  id: string;
  name: string;
  email: string;
  team_id: string;
}

export interface Member {
  user_id: string;
  email: string;
  role: 'admin' | 'member' | 'viewer';
  team_id: string;
}

class FakeAPI {
  private customers: Customer[] = [
    { id: 'c_1', name: '张伟', email: 'wei@acme.com', team_id: 't_demo' },
    { id: 'c_2', name: 'Alice Chen', email: 'alice@acme.com', team_id: 't_demo' },
    { id: 'c_3', name: '李娜', email: 'na@acme.com', team_id: 't_demo' },
  ];
  private members: Member[] = [
    { user_id: 'u_demo', email: 'demo@acme.com', role: 'admin', team_id: 't_demo' },
  ];
  private inviteCounter = 0;

  customers_list(team_id: string, limit: number) {
    return this.customers.filter((c) => c.team_id === team_id).slice(0, limit);
  }

  customer_count(team_id: string) {
    return this.customers.filter((c) => c.team_id === team_id).length;
  }

  users_is_member_of(team_id: string, email: string): boolean {
    return this.members.some((m) => m.team_id === team_id && m.email === email);
  }

  invites_create(team_id: string, email: string, role: Member['role']) {
    this.inviteCounter++;
    const id = `inv_${this.inviteCounter}`;
    // Simulate creating an invite record + sending email
    return { id, team_id, email, role, status: 'sent' as const };
  }
}

export const platformAPI = new FakeAPI();
export type PlatformAPI = typeof platformAPI;
