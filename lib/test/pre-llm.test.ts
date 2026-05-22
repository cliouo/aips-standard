/**
 * Tests for §22 pre-LLM PII shielding.
 */

import { describe, it, expect } from 'vitest';
import {
  PIIVault,
  RegionRouter,
  shieldPII,
  preparePromptForLLM,
} from '../src/index.js';

describe('§22 PIIVault', () => {
  it('shields a string with stable placeholders within a session', () => {
    const vault = new PIIVault('fixed-salt');
    const p1 = vault.shield('email', 'a@b.com');
    const p2 = vault.shield('email', 'a@b.com');
    const p3 = vault.shield('email', 'c@d.com');
    expect(p1).toBe(p2);
    expect(p1).not.toBe(p3);
    expect(p1).toMatch(/^<pii:email:[0-9a-f]{6}>$/);
  });

  it('rehydrates placeholders back to real values', () => {
    const vault = new PIIVault();
    const p = vault.shield('email', 'alice@example.com');
    const llmOutput = `已向 ${p} 发送邀请。`;
    expect(vault.rehydrate(llmOutput)).toBe('已向 alice@example.com 发送邀请。');
  });

  it('different vaults yield different placeholders for the same value', () => {
    const v1 = new PIIVault();
    const v2 = new PIIVault();
    expect(v1.shield('email', 'a@b.com')).not.toBe(v2.shield('email', 'a@b.com'));
  });
});

describe('§22 shieldPII walks nested structures', () => {
  it('shields strings inside arrays and objects', () => {
    const vault = new PIIVault();
    const input = {
      summary: 'invited 2 users',
      members: [
        { name: 'Alice', email: 'alice@x.com' },
        { name: 'Bob', email: 'bob@x.com' },
      ],
      note: 'contact 192.168.1.1 for help',
    };
    const out = shieldPII(input, vault) as any;
    expect(out.members[0].email).toMatch(/^<pii:email:/);
    expect(out.members[1].email).toMatch(/^<pii:email:/);
    expect(out.members[0].email).not.toBe(out.members[1].email);
    expect(out.note).toMatch(/<pii:ip:/);
    expect(out.summary).toBe('invited 2 users'); // unchanged
  });

  it('detects credit cards and tokens', () => {
    const vault = new PIIVault();
    const out = shieldPII(
      'pay with 4111-1111-1111-1111 and use key sk-ABCDEFGHIJKLMNOPQRST',
      vault,
    ) as string;
    expect(out).toMatch(/<pii:credit_card:/);
    expect(out).toMatch(/<pii:token:/);
  });
});

describe('§22 preparePromptForLLM round-trip', () => {
  it('shields outbound, rehydrates inbound', () => {
    const vault = new PIIVault();
    const toolResult = { items: [{ email: 'a@b.com' }, { email: 'c@d.com' }] };
    const safe = preparePromptForLLM(toolResult, vault) as any;
    expect(safe.items[0].email).toMatch(/^<pii:email:/);
    expect(safe.items[1].email).toMatch(/^<pii:email:/);

    // Simulate LLM final response that references both placeholders
    const llmText = `通知 ${safe.items[0].email} 和 ${safe.items[1].email}`;
    expect(vault.rehydrate(llmText)).toBe('通知 a@b.com 和 c@d.com');
  });
});

describe('§22 RegionRouter', () => {
  it('returns the configured endpoint for a known region', () => {
    const router = new RegionRouter()
      .set('us', { baseURL: 'https://us.example' })
      .set('eu', { baseURL: 'https://eu.example' })
      .setFallback({ baseURL: 'https://global.example' });
    expect(router.resolve('eu').baseURL).toBe('https://eu.example');
    expect(router.resolve('us').baseURL).toBe('https://us.example');
  });

  it('falls back when region is unknown', () => {
    const router = new RegionRouter().setFallback({ baseURL: 'https://global.example' });
    expect(router.resolve('mars').baseURL).toBe('https://global.example');
    expect(router.resolve(undefined).baseURL).toBe('https://global.example');
  });

  it('throws when no fallback and unknown region', () => {
    const router = new RegionRouter();
    expect(() => router.resolve('mars')).toThrow(/No endpoint/);
  });
});
