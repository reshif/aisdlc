import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvalGrader } from '@aisdlc/contracts';
import { manualClock } from '@aisdlc/kernel';
import { fakeKeyCustody, type KeyCustodyPort } from '@aisdlc/ports';
import { PINNED_KEY_FORMAT, type PinnedKey } from '../src/pinned.js';
import { addCase, initStore, signStore } from '../src/authoring.js';
import { EvalStore } from '../src/store.js';
import type { AgentRunRequest } from '../src/runner-port.js';

export const KEY_ID = 'dev:eval-store';
export const clock = () => manualClock('2026-11-09T10:00:00.000Z');

/** A store directory OUTSIDE the repo (the OS temp dir), removed by `cleanup`. */
export const dirs: string[] = [];
export const mkTmp = (prefix = 'aisdlc-evalstore-'): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
export const cleanup = (): void => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
};

export const custody = (seed = 'test'): KeyCustodyPort => fakeKeyCustody({ seed });

export async function pinnedOf(c: KeyCustodyPort): Promise<PinnedKey> {
  const k = await c.publicKey(KEY_ID);
  if (!k.ok) throw new Error('no key');
  return {
    format: PINNED_KEY_FORMAT,
    key_id: KEY_ID,
    jwk: { kty: 'EC', crv: 'P-256', x: k.value['x'] as string, y: k.value['y'] as string },
  };
}

const classification = (candidate: string, rationale = 'a small change in one module') => ({
  kind: 'classification',
  candidate,
  confidence: 0.8,
  rationale,
});

interface Spec {
  id: string;
  candidate: string;
  grader: EvalGrader;
  security?: boolean;
}
/** Five cases of agent A1, one per grader type, one security-tagged. */
export const SPECS: Spec[] = [
  { id: 't-exact', candidate: 'L3', grader: { type: 'exact', value: classification('L3') } },
  { id: 't-subset', candidate: 'L1', grader: { type: 'json_subset', value: { candidate: 'L1' } } },
  {
    id: 't-regex',
    candidate: 'L4',
    grader: { type: 'regex', pattern: '^L[0-9]$', path: 'candidate' },
  },
  {
    id: 't-schema',
    candidate: 'L3',
    grader: {
      type: 'schema',
      schema: {
        type: 'object',
        required: ['kind', 'candidate'],
        properties: { candidate: { enum: ['L3', 'L4'] } },
      },
    },
  },
  {
    id: 't-security',
    candidate: 'L5',
    grader: { type: 'json_subset', value: { candidate: 'L5' } },
    security: true,
  },
];

export const draftOf = (s: Spec, over: Record<string, unknown> = {}) => ({
  case_id: s.id,
  suite_id: 'triage',
  kind: 'regression',
  agent_id: 'A1',
  profile: 'A1.classify',
  project_tag: null,
  security_tagged: s.security ?? false,
  input: { id: s.id, request: `request of ${s.id}` },
  grader: s.grader,
  ...over,
});

/** What a faithful A1 answers for a case input. */
export const goodAnswer = (req: Pick<AgentRunRequest, 'input'>): string => {
  const spec = SPECS.find((s) => s.id === req.input['id']);
  return JSON.stringify(classification(spec?.candidate ?? 'L3'));
};
/** The same agent after a regression: it answers L6 for every case. */
export const badAnswer = (): string => JSON.stringify(classification('L6'));

export interface BuiltStore {
  path: string;
  custody: KeyCustodyPort;
  pinned: PinnedKey;
  open(): ReturnType<typeof EvalStore.open>;
  sign(): Promise<void>;
}

export async function buildStore(
  o: { holdout?: boolean; seed?: string; cases?: Spec[] } = {},
): Promise<BuiltStore> {
  const path = mkTmp();
  const c = custody(o.seed);
  const pinned = await pinnedOf(c);
  const init = await initStore(path, {
    store_id: 'test-store',
    key_id: KEY_ID,
    custody: c,
    clock: clock(),
  });
  if (!init.ok) throw new Error(init.error.message);
  for (const s of o.cases ?? SPECS) {
    const r = addCase(path, draftOf(s));
    if (!r.ok) throw new Error(r.error.message);
  }
  if (o.holdout) {
    const r = addCase(
      path,
      draftOf(
        { id: 'h-1', candidate: 'L2', grader: { type: 'json_subset', value: { candidate: 'L2' } } },
        { kind: 'holdout', input: { id: 'h-1', request: 'the held-out request' } },
      ),
    );
    if (!r.ok) throw new Error(r.error.message);
  }
  const sign = async () => {
    const r = await signStore(path, { key_id: KEY_ID, custody: c, clock: clock() });
    if (!r.ok) throw new Error(r.error.message);
  };
  await sign();
  return { path, custody: c, pinned, open: () => EvalStore.open(path, { pinned }), sign };
}
