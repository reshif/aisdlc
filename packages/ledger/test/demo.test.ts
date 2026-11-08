import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'demo-ledger.mjs');
const leftovers = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('aisdlc-demo-'));

describe('M2 exit demo (scripts/demo-ledger.mjs)', () => {
  it('runs the three services as processes, verifies the ledger, detects a tampered row, cleans up', async () => {
    expect(leftovers()).toEqual([]);
    const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const c = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.stderr.on('data', (d) => (out += d));
      c.on('close', (code) => resolve({ code, out }));
    });
    expect(r.out).toMatch(/ledger OK: 10 entries, chain intact/);
    expect(r.out).toMatch(/checkpoints OK: 1,/);
    expect(r.out).toMatch(/verify-ledger FAILED \[entry_hash\]: entry 5/);
    expect(r.out).toMatch(/witness stopped cleanly \(exit 0\)/);
    expect(r.out).toMatch(/demo OK/);
    expect(r.code).toBe(0);
    // No temp directory (key dir, tokens, Postgres cluster) survives the run.
    expect(leftovers()).toEqual([]);
  }, 60_000);
});
