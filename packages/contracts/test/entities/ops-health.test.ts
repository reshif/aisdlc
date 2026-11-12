import { describe, expect, it } from 'vitest';
import {
  FACTORY_SERVICES,
  HEALTH_SNAPSHOT_STALE_MS,
  HealthSnapshot,
  HealthView,
  healthViewOf,
  worstHealth,
  type HealthSnapshot as Snap,
} from '../../src/index.js';

// M19: HealthTile and HealthSnapshot. A reading older than two minutes is unknown, never green; a service nobody has
// read is unknown with `no_report`; the overall state is ok only when every tile is fresh and ok.

const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const snap = (tile_id: string, state: Snap['state'], ageMs = 0, over: Partial<Snap> = {}): Snap =>
  HealthSnapshot.parse({
    tile_id,
    domain: tile_id.startsWith('loop.') ? 'loop' : 'service',
    state,
    detail_code: state === 'ok' ? 'ok' : 'unhealthy',
    sli_value: 12,
    reporter: 'core-worker',
    as_of: new Date(NOW - ageMs).toISOString(),
    ...over,
  });

describe('healthViewOf', () => {
  it('lists every factory service, unknown with no_report when nothing read it', () => {
    const v = HealthView.parse(healthViewOf([], NOW));
    expect(v.tiles.map((t) => t.label)).toEqual([...FACTORY_SERVICES]);
    expect(v.tiles.every((t) => t.state === 'unknown' && t.detail_code === 'no_report')).toBe(true);
    expect(v.overall).toBe('unknown');
    expect(v.counts.unknown).toBe(FACTORY_SERVICES.length);
  });

  it('a fresh reading shows; one older than two minutes is unknown and stale, never ok', () => {
    const v = healthViewOf(
      [
        snap('service.notary', 'ok', 1_000),
        snap('service.core', 'ok', HEALTH_SNAPSHOT_STALE_MS + 1),
        snap('service.gateway', 'down', 0, { detail_code: 'unreachable', sli_value: null }),
      ],
      NOW,
    );
    const by = new Map(v.tiles.map((t) => [t.tile_id, t]));
    expect(by.get('service.notary')).toMatchObject({ state: 'ok', stale: false, sli_value: 12 });
    expect(by.get('service.core')).toMatchObject({
      state: 'unknown',
      stale: true,
      detail_code: 'stale',
      sli_value: null,
    });
    expect(by.get('service.gateway')).toMatchObject({ state: 'down', detail_code: 'unreachable' });
    expect(v.overall).toBe('down');
  });

  it('a reading from the future is unknown (a clock cannot keep a tile green)', () => {
    const v = healthViewOf([snap('service.notary', 'ok', -60_000)], NOW);
    expect(v.tiles.find((t) => t.tile_id === 'service.notary')?.state).toBe('unknown');
  });

  it('loops are tiles after the services, labelled host / loop', () => {
    const v = healthViewOf(
      [snap('loop.core-worker.outbox_watch', 'degraded'), snap('loop.core-worker.cards', 'ok')],
      NOW,
    );
    const loops = v.tiles.filter((t) => t.domain === 'loop');
    expect(loops.map((t) => t.label)).toEqual([
      'core-worker / cards',
      'core-worker / outbox_watch',
    ]);
  });

  it('worstHealth: ok only when all are ok; nothing is unknown', () => {
    expect(worstHealth([])).toBe('unknown');
    expect(worstHealth(['ok', 'ok'])).toBe('ok');
    expect(worstHealth(['ok', 'unknown'])).toBe('unknown');
    expect(worstHealth(['unknown', 'degraded'])).toBe('degraded');
    expect(worstHealth(['degraded', 'down', 'ok'])).toBe('down');
  });

  it('a tile id is service.<name> or loop.<host>.<loop>', () => {
    expect(() => snap('notary', 'ok')).toThrow();
    expect(() => snap('service.Notary', 'ok')).toThrow();
  });
});
