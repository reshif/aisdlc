import { buildSourceError } from '@aisdlc/build';
import { err, ok } from '@aisdlc/kernel';
import {
  FakeSandbox,
  type FakeSandboxOutcome,
  type FakeSandboxScript,
  type RepoFile,
} from '@aisdlc/ports';
import { runOnboardingProbe, type ProbeRunDeps } from '../src/index.js';
import type { Scn } from './harness.js';

// The onboarding probe in the core tests (M16): a FakeSandbox behind the port in place of the sandbox-controller,
// the repo copy as a fixed file set, the image and the owner allow-list as the config readers would answer.

export const PROBE_IMAGE = {
  image: `aisdlc/sandbox-onboarding@sha256:${'1'.repeat(64)}`,
  lock_sha256: 'f'.repeat(64),
};

export const runnerReport = (setup: number | null, test: number | null) =>
  JSON.stringify({
    schema: 'aisdlc-probe/1',
    setup: setup === null ? null : { exit_code: setup, duration_ms: 12 },
    test: test === null ? null : { exit_code: test, duration_ms: 34 },
  });

export const junit = (tests: number, failures = 0) =>
  `<testsuites tests="${tests}" failures="${failures}" errors="0" skipped="0"></testsuites>`;

/** A session where the repo's test exits 0 with `tests` tests (no setup declared in the fixture facts). */
export const passing =
  (tests = 4, extra: Record<string, string> = {}): FakeSandboxScript =>
  (): FakeSandboxOutcome => ({
    exit_code: 0,
    out: {
      'aisdlc-probe/result.json': runnerReport(null, 0),
      'aisdlc-probe/test.log': `ran ${tests} tests\n`,
      'aisdlc-probe/junit.xml': junit(tests),
      ...extra,
    },
  });

export const REPO_FILES: RepoFile[] = [
  { path: 'package.json', content: '{"scripts":{"test":"node --test"}}' },
  { path: 'test/a.test.js', content: "require('node:test')('a', () => {});" },
];

export interface ProbeRig {
  readonly deps: ProbeRunDeps;
  readonly sandbox: FakeSandbox;
  allow: string[];
  image: typeof PROBE_IMAGE | null;
}

export function probeRig(
  c: Scn,
  o: { script?: FakeSandboxScript; allow?: boolean; image?: boolean; filesFail?: boolean } = {},
): ProbeRig {
  const sandbox = new FakeSandbox(o.script ?? passing());
  const rig: ProbeRig = {
    sandbox,
    allow: o.allow === false ? [] : [c.repo],
    image: o.image === false ? null : PROBE_IMAGE,
    deps: undefined as never,
  };
  (rig as { deps: ProbeRunDeps }).deps = {
    pool: c.deps.pool,
    ...(c.deps.clock ? { clock: c.deps.clock } : {}),
    knowledge: c.knowledge,
    probe: {
      sandbox,
      files: {
        files: async () =>
          o.filesFail ? err(buildSourceError('unavailable', 'down')) : ok(REPO_FILES),
      },
      image: () => rig.image,
      execAllowedRepos: () => rig.allow,
    },
  };
  return rig;
}

/** Runs a passing probe for the record (what card 2's LF3 needs before an approval). */
export async function passProbe(c: Scn): Promise<void> {
  const r = await runOnboardingProbe(probeRig(c).deps, c.s0);
  if (!r.ok) throw new Error(r.error.message);
  if (r.value.result.outcome !== 'passed') throw new Error(`probe ${r.value.result.outcome}`);
}
