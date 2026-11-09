import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvalBaselineFile, EvalRunRecord, EvalTrigger, type GitSha } from '@aisdlc/contracts';
import { systemClock, type Clock } from '@aisdlc/kernel';
import type { KeyCustodyPort } from '@aisdlc/ports';
import { resolveSecretRef } from '@aisdlc/service-kit';
import { HttpKeyCustody } from '@aisdlc/kms-local/client';
import { z } from 'zod';
import { addCase, initStore, setBaseline, signStore } from './authoring.js';
import { baselineFrom, baselineFor, compareRuns, gateRun } from './compare.js';
import { GatewayAgentRunner } from './gateway-runner.js';
import { PINNED_KEY_FORMAT, PINNED_KEY_PATH, loadPinnedKey, type PinnedKey } from './pinned.js';
import { runSuite } from './runner.js';
import type { AgentRunner } from './runner-port.js';
import { CoreEvalSink, type EvalRunSink } from './sink.js';
import { EvalStore } from './store.js';
import { loadSuite } from './suite.js';
import { readFileSync as read } from 'node:fs';

// `aisdlc-evals` (PLAN M11.3): init | add-case | baseline | sign | verify | pin | run | compare | gate.
// The store is `AISDLC_EVAL_STORE`, a directory OUTSIDE the repo. Exit codes: 0 done, 1 the answer is
// no (a store that does not verify, a failed gate), 2 usage or configuration.

export interface CliContext {
  readonly env: Record<string, string | undefined>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Key custody for signing. Default: kms-local over HTTP (`AISDLC_KMS_URL`, `AISDLC_KMS_TOKEN_REF`). */
  readonly custody?: () => KeyCustodyPort;
  /** The pinned key to verify with. Default: `eval_store.pub.json` of this package. */
  readonly pinned?: PinnedKey;
  /** The agent runner for `run`. Default: the gateway (`AISDLC_EVAL_GATEWAY_URL`, `AISDLC_EVAL_VKEYS`). */
  readonly runner?: () => AgentRunner;
  /** Where `run --record` sends the run. Default: core (`AISDLC_CORE_URL`, `AISDLC_CORE_TOKEN_REF`). */
  readonly sink?: () => EvalRunSink;
  readonly clock?: Clock;
}

class Usage extends Error {}

function parseArgs(argv: readonly string[]): {
  cmd: string;
  pos: string[];
  flags: Map<string, string>;
} {
  const [cmd = '', ...rest] = argv;
  const pos: string[] = [];
  const flags = new Map<string, string>();
  const BOOL = new Set(['include-holdout', 'record']);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i] as string;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (BOOL.has(name)) flags.set(name, 'true');
      else {
        const v = rest[i + 1];
        if (v === undefined || v.startsWith('--')) throw new Usage(`--${name} needs a value`);
        flags.set(name, v);
        i += 1;
      }
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

const keyIdOf = (env: CliContext['env']): string => env['AISDLC_EVAL_KEY_ID'] ?? 'dev:eval-store';
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

function defaultCustody(env: CliContext['env']): KeyCustodyPort {
  const url = env['AISDLC_KMS_URL'];
  const ref = env['AISDLC_KMS_TOKEN_REF'];
  if (!url || !ref) throw new Usage('AISDLC_KMS_URL and AISDLC_KMS_TOKEN_REF are needed to sign');
  return new HttpKeyCustody({ baseUrl: url, token: resolveSecretRef(ref, { env }) });
}

function defaultRunner(env: CliContext['env']): AgentRunner {
  const baseUrl = env['AISDLC_EVAL_GATEWAY_URL'];
  const vkeys = env['AISDLC_EVAL_VKEYS'];
  const provider = env['AISDLC_EVAL_PROVIDER'];
  const model = env['AISDLC_EVAL_MODEL'];
  if (!baseUrl || !vkeys || !provider || !model) {
    throw new Usage(
      'AISDLC_EVAL_GATEWAY_URL, AISDLC_EVAL_VKEYS, AISDLC_EVAL_PROVIDER and AISDLC_EVAL_MODEL are needed to run',
    );
  }
  const refs = z.record(z.string(), z.string()).parse(JSON.parse(vkeys));
  const promptsDir = env['AISDLC_PROMPTS_DIR'];
  return new GatewayAgentRunner({
    baseUrl,
    provider,
    model,
    keyFor: (agent) => {
      const ref = refs[agent];
      if (ref === undefined)
        throw new Usage(`no virtual key for agent ${agent} in AISDLC_EVAL_VKEYS`);
      return resolveSecretRef(ref, { env });
    },
    ...(env['AISDLC_EVAL_PRICE_IN'] && env['AISDLC_EVAL_PRICE_OUT']
      ? {
          price: {
            in_per_mtok: Number(env['AISDLC_EVAL_PRICE_IN']),
            out_per_mtok: Number(env['AISDLC_EVAL_PRICE_OUT']),
          },
        }
      : {}),
    // a deployed bundle has no `src/prompts`: it reads a copy named by the environment
    ...(promptsDir
      ? { promptReader: (ref: string) => read(join(promptsDir, `${ref}.md`), 'utf8') }
      : {}),
  });
}

function defaultSink(env: CliContext['env']): EvalRunSink {
  const baseUrl = env['AISDLC_CORE_URL'];
  const ref = env['AISDLC_CORE_TOKEN_REF'];
  if (!baseUrl || !ref)
    throw new Usage('AISDLC_CORE_URL and AISDLC_CORE_TOKEN_REF are needed to record a run');
  return new CoreEvalSink({ baseUrl, token: resolveSecretRef(ref, { env }) });
}

const num = (v: string | undefined, name: string, d: number): number => {
  if (v === undefined) return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Usage(`--${name} must be a number`);
  return n;
};

export async function runCli(argv: readonly string[], ctx: CliContext): Promise<number> {
  const say = (v: unknown) => ctx.out(`${JSON.stringify(v, null, 2)}\n`);
  const clock = ctx.clock ?? systemClock;
  try {
    const { cmd, pos, flags } = parseArgs(argv);
    const storePath = ctx.env['AISDLC_EVAL_STORE'];
    const custody = (): KeyCustodyPort => (ctx.custody ?? (() => defaultCustody(ctx.env)))();
    const pinned = (): PinnedKey | undefined => ctx.pinned;
    const open = async () =>
      EvalStore.open(storePath, { ...(pinned() ? { pinned: pinned() as PinnedKey } : {}) });
    const refuse = (e: { code: string; message: string }): number => {
      ctx.err(`${e.code}: ${e.message}\n`);
      return 1;
    };

    switch (cmd) {
      case 'init': {
        const id = flags.get('store-id');
        if (!id) throw new Usage('init needs --store-id');
        const r = await initStore(storePath, {
          store_id: id,
          key_id: keyIdOf(ctx.env),
          custody: custody(),
          clock,
        });
        if (!r.ok) return refuse(r.error);
        say({ ok: true, store: r.value });
        return 0;
      }
      case 'add-case': {
        const file = pos[0];
        if (!file) throw new Usage('add-case needs a case file');
        const r = addCase(storePath, readJson(file));
        if (!r.ok) return refuse(r.error);
        say({ ...r.value, note: 'the manifest is stale until `aisdlc-evals sign`' });
        return 0;
      }
      case 'baseline': {
        const file = flags.get('run');
        if (!file) throw new Usage('baseline needs --run <run.json>');
        const run = EvalRunRecord.parse(readJson(file));
        const b = baselineFrom(run, {
          baseline_id: `${run.suite_id}-${run.provider}-${run.eval_run_id.slice(0, 8)}`,
          created_at: clock.now().toISOString(),
        });
        const r = setBaseline(storePath, b);
        if (!r.ok) return refuse(r.error);
        say({
          baseline_id: b.baseline_id,
          provider: b.provider,
          note: 'a baseline is a gated change: approve it, then `aisdlc-evals sign`',
        });
        return 0;
      }
      case 'sign': {
        const r = await signStore(storePath, {
          ...(flags.get('store-id') ? { store_id: flags.get('store-id') as string } : {}),
          key_id: keyIdOf(ctx.env),
          custody: custody(),
          clock,
        });
        if (!r.ok) return refuse(r.error);
        say({ ok: true, store_id: r.value.store_id, files: Object.keys(r.value.files).length });
        return 0;
      }
      case 'verify': {
        const s = await open();
        if (!s.ok) return refuse(s.error);
        say({
          ok: true,
          store_id: s.value.store_id,
          manifest_digest: s.value.manifest_digest,
          files: Object.keys(s.value.manifest.files).length,
        });
        return 0;
      }
      case 'pin': {
        const jwk = await custody().publicKey(keyIdOf(ctx.env));
        if (!jwk.ok) return refuse({ code: 'custody', message: jwk.error.kind });
        const body: PinnedKey = {
          format: PINNED_KEY_FORMAT,
          key_id: keyIdOf(ctx.env),
          jwk: {
            kty: 'EC',
            crv: 'P-256',
            x: jwk.value['x'] as string,
            y: jwk.value['y'] as string,
            kid: keyIdOf(ctx.env),
            alg: 'ES256',
            use: 'sig',
          },
        };
        writeFileSync(PINNED_KEY_PATH, `${JSON.stringify(body, null, 2)}\n`);
        say({
          pinned: body.key_id,
          path: PINNED_KEY_PATH,
          note: 'commit this file: it is the repo-side trust root of the eval store',
        });
        return 0;
      }
      case 'run': {
        const suiteId = flags.get('suite');
        if (!suiteId) throw new Usage('run needs --suite');
        const k = num(flags.get('k'), 'k', 3);
        if (!Number.isInteger(k) || k < 1 || k > 50)
          throw new Usage('--k is an integer from 1 to 50');
        const trigger = EvalTrigger.safeParse(flags.get('trigger') ?? 'manual');
        if (!trigger.success)
          throw new Usage(`--trigger is one of ${EvalTrigger.options.join(', ')}`);
        const s = await open();
        if (!s.ok) return refuse(s.error);
        const suite = loadSuite(s.value, suiteId, { includeHoldout: flags.has('include-holdout') });
        if (!suite.ok) return refuse(suite.error);
        const gitSha = ctx.env['GIT_SHA'];
        const run = await runSuite({
          suite: suite.value.suite,
          cases: suite.value.cases,
          graderOf: suite.value.graderOf,
          runner: (ctx.runner ?? (() => defaultRunner(ctx.env)))(),
          k,
          store_id: s.value.store_id,
          manifest_digest: s.value.manifest_digest,
          trigger: trigger.data,
          git_sha: gitSha && /^[0-9a-f]{40}$/.test(gitSha) ? (gitSha as GitSha) : null,
          clock,
        });
        if (flags.has('record')) {
          const rec = await (ctx.sink ?? (() => defaultSink(ctx.env)))().record(run);
          if (!rec.ok) return refuse(rec.error);
        }
        const out = flags.get('out');
        if (out) writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`);
        say(out ? { eval_run_id: run.eval_run_id, out, recorded: flags.has('record') } : run);
        return 0;
      }
      case 'compare':
      case 'gate': {
        const file = flags.get('run');
        if (!file) throw new Usage(`${cmd} needs --run <run.json>`);
        const run = EvalRunRecord.parse(readJson(file));
        const s = await open();
        if (!s.ok) return refuse(s.error);
        const bl = s.value.baselines(run.provider);
        if (!bl.ok) return refuse(bl.error);
        const baseline = baselineFor(bl.value, run);
        const level = num(flags.get('level'), 'level', 0.9);
        if (cmd === 'compare') {
          say(compareRuns(run, baseline, { level }));
          return 0;
        }
        const g = gateRun(run, baseline, { level, floor: num(flags.get('floor'), 'floor', 0.8) });
        say(g);
        return g.passed ? 0 : 1;
      }
      default:
        throw new Usage(
          'usage: aisdlc-evals init|add-case|baseline|sign|verify|pin|run|compare|gate',
        );
    }
  } catch (e) {
    ctx.err(
      `${e instanceof Usage ? 'usage' : 'error'}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 2;
  }
}

export { EvalBaselineFile, loadPinnedKey };
