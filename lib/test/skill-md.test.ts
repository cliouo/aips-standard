/**
 * Tests for Agent Skills v1 compliance of toSkillMarkdown.
 */

import { describe, it, expect } from 'vitest';
import {
  ActionRegistry,
  MemoryConfirmationStore,
  MemoryIdempotencyStore,
  MemoryLoopDetector,
  MemoryRateLimiter,
  toSkillMarkdown,
  validateSkillName,
} from '../src/index.js';
import { echoAction, writeAction } from './helpers.js';

function registry() {
  // Give the actions a domain so toSkillMarkdown picks them up
  echoAction.spec.domain = 'team';
  writeAction.spec.domain = 'team';
  return new ActionRegistry({
    idempotency: new MemoryIdempotencyStore(),
    confirmation: new MemoryConfirmationStore(),
    rateLimit: new MemoryRateLimiter(),
    loop: new MemoryLoopDetector(),
  }).register(echoAction, writeAction);
}

describe('validateSkillName (Agent Skills v1)', () => {
  it('accepts compliant names', () => {
    expect(() => validateSkillName('acme-team')).not.toThrow();
    expect(() => validateSkillName('a')).not.toThrow();
    expect(() => validateSkillName('foo-bar-baz')).not.toThrow();
  });
  it('rejects leading hyphens', () => {
    expect(() => validateSkillName('-foo')).toThrow();
  });
  it('rejects trailing hyphens', () => {
    expect(() => validateSkillName('foo-')).toThrow();
  });
  it('rejects consecutive hyphens', () => {
    expect(() => validateSkillName('foo--bar')).toThrow();
  });
  it('rejects uppercase / underscore / unicode', () => {
    expect(() => validateSkillName('Foo')).toThrow();
    expect(() => validateSkillName('foo_bar')).toThrow();
    expect(() => validateSkillName('团队')).toThrow();
  });
  it('rejects over-long names', () => {
    expect(() => validateSkillName('a'.repeat(65))).toThrow();
  });
});

describe('toSkillMarkdown — v1 frontmatter', () => {
  it('emits name/description/allowed-tools', () => {
    const md = toSkillMarkdown(registry(), 'team', { vendorPrefix: 'acme' });
    expect(md).toContain('name: acme-team');
    expect(md).toContain('description:');
    expect(md).toContain('allowed-tools:');
    expect(md).toContain('Bash(acme echo *)');
  });

  it('includes license when provided', () => {
    const md = toSkillMarkdown(registry(), 'team', {
      vendorPrefix: 'acme',
      license: 'Apache-2.0',
    });
    expect(md).toContain('license: Apache-2.0');
  });

  it('throws on a vendor prefix that would produce an invalid name', () => {
    expect(() =>
      toSkillMarkdown(registry(), 'team', { vendorPrefix: 'ACME' }),
    ).toThrow(/Agent Skills v1/);
  });
});
