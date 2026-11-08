import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', 'generated'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (/\.(ts|mjs)$/.test(name)) yield p;
  }
}

describe('identity is the single writer of the identity journal', () => {
  it('nothing outside services/identity imports its writer (only `@aisdlc/identity/read` and `/testing` are shared)', () => {
    const offenders: string[] = [];
    for (const area of ['packages', 'services', 'scripts']) {
      for (const file of sources(join(root, area))) {
        const rel = relative(root, file);
        if (rel.startsWith(join('services', 'identity') + '/')) continue;
        const text = readFileSync(file, 'utf8');
        if (
          /from '@aisdlc\/identity'|import\('@aisdlc\/identity'\)|require\('@aisdlc\/identity'\)/.test(
            text,
          )
        ) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only identity (and the directory and tests that read them) names identity journal streams in an append', () => {
    // The journal's event types are appended only inside services/identity/src.
    const offenders: string[] = [];
    for (const area of ['packages', 'services']) {
      for (const file of sources(join(root, area))) {
        const rel = relative(root, file);
        if (!/\/src\//.test(rel) || rel.includes(join('services', 'identity') + '/')) continue;
        if (rel.startsWith(join('packages', 'contracts') + '/')) continue;
        const text = readFileSync(file, 'utf8');
        if (
          /appendEvents\(/.test(text) &&
          /IDENTITY_EVENT|principalStream|groupStream|bindingStream/.test(text)
        ) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the read-only export surface has no commands', async () => {
    const read = await import('../src/read.js');
    for (const name of Object.keys(read)) {
      expect(name).not.toMatch(
        /^(create|update|set|add|remove|revoke|grant|link|unlink|reconcile|sync)[A-Z]/,
      );
    }
  });
});
