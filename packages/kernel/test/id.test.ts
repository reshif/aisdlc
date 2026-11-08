import { describe, expect, it } from 'vitest';
import {
  isOk,
  newId,
  parseUuid,
  uuidv7Generator,
  uuidv7Timestamp,
  manualClock,
  type Id,
} from '../src/index.js';

describe('uuid v7', () => {
  it('has version 7 and RFC variant', () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('encodes the timestamp', () => {
    const clock = manualClock('2026-11-08T00:00:00Z');
    expect(uuidv7Timestamp(newId(clock.nowMs()))).toBe(clock.nowMs());
  });

  it('is strictly time-ordered, even within one millisecond and with a stalled clock', () => {
    const gen = uuidv7Generator();
    const ids: string[] = [];
    for (let i = 0; i < 10_000; i++) ids.push(gen(1_700_000_000_000));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    const later = gen(1_700_000_100_000);
    expect(later > ids[ids.length - 1]!).toBe(true);
  });

  it('parses valid uuids and rejects others', () => {
    const r = parseUuid('0191A2B3-C4D5-7E6F-8A9B-0C1D2E3F4A5B');
    expect(isOk(r) && r.value).toBe('0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b');
    const bad = parseUuid('nope');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error._tag).toBe('InvalidUuid');
  });

  it('brands are distinct at the type level', () => {
    const p: Id<'Project'> = newId<'Project'>();
    // @ts-expect-error a Project id is not a Repo id
    const r: Id<'Repo'> = p;
    expect(r).toBe(p);
  });
});

describe('deterministicId', () => {
  it('is stable, well formed and seed-sensitive', async () => {
    const { deterministicId, parseUuid } = await import('../src/id.js');
    const a = deterministicId<'X'>('seed-1');
    expect(a).toBe(deterministicId<'X'>('seed-1'));
    expect(a).not.toBe(deterministicId<'X'>('seed-2'));
    expect(parseUuid(a).ok).toBe(true);
    expect(a[14]).toBe('8');
    expect('89ab').toContain(a[19]);
  });
});
