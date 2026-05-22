/**
 * Tests for OpenAPI export — structural sanity, not full validation.
 */

import { describe, it, expect } from 'vitest';
import {
  ActionRegistry,
  MemoryConfirmationStore,
  MemoryIdempotencyStore,
  MemoryLoopDetector,
  MemoryRateLimiter,
  toOpenAPI,
} from '../src/index.js';
import { echoAction, writeAction } from './helpers.js';

function build() {
  const r = new ActionRegistry({
    idempotency: new MemoryIdempotencyStore(),
    confirmation: new MemoryConfirmationStore(),
    rateLimit: new MemoryRateLimiter(),
    loop: new MemoryLoopDetector(),
  }).register(echoAction, writeAction);
  return toOpenAPI(r, { title: 'T', version: '0.0.1' });
}

describe('toOpenAPI', () => {
  it('produces openapi 3.1 root', () => {
    const doc = build() as any;
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('T');
  });

  it('emits one POST path per action with kebab name', () => {
    const doc = build() as any;
    expect(doc.paths['/api/v1/actions/echo']).toBeDefined();
    expect(doc.paths['/api/v1/actions/do-write']).toBeDefined();
    expect(doc.paths['/api/v1/actions/echo'].post.operationId).toBe('echo');
  });

  it('declares 409 PENDING_CONFIRMATION on write actions', () => {
    const doc = build() as any;
    const op = doc.paths['/api/v1/actions/do-write'].post;
    expect(op.responses['409']).toBeDefined();
    expect(op.responses['409'].description).toMatch(/PENDING_CONFIRMATION/);
  });

  it('does not declare 409 PENDING_CONFIRMATION on read actions', () => {
    const doc = build() as any;
    const op = doc.paths['/api/v1/actions/echo'].post;
    // read still has generic 409 CONFLICT but should not require X-Confirmation-Token
    const hasTokenParam = op.parameters.some(
      (p: any) => p.name === 'X-Confirmation-Token',
    );
    expect(hasTokenParam).toBe(false);
  });

  it('requires Idempotency-Key on writes, optional on reads', () => {
    const doc = build() as any;
    const writeParams = doc.paths['/api/v1/actions/do-write'].post.parameters;
    const readParams = doc.paths['/api/v1/actions/echo'].post.parameters;
    const writeKey = writeParams.find((p: any) => p.name === 'Idempotency-Key');
    const readKey = readParams.find((p: any) => p.name === 'Idempotency-Key');
    expect(writeKey.required).toBe(true);
    expect(readKey.required).toBe(false);
  });

  it('exposes Refract-specific fields under x-aips', () => {
    const doc = build() as any;
    const xa = doc.paths['/api/v1/actions/do-write'].post['x-aips'];
    expect(xa.risk).toBe('write');
    expect(xa.requires_confirmation).toBe(true);
    expect(xa.version).toBe('1.0');
  });

  it('emits an RefractError component referenced from all 4xx/5xx', () => {
    const doc = build() as any;
    expect(doc.components.schemas.RefractError).toBeDefined();
    const op = doc.paths['/api/v1/actions/echo'].post;
    expect(op.responses['400'].content['application/json'].schema.$ref).toMatch(
      /RefractError/,
    );
  });
});
