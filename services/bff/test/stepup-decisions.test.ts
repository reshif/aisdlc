import { PrincipalId, ProjectId, type Sha256Hex } from '@aisdlc/contracts';
import {
  decide,
  openGate,
  prepare,
  recordEvidenceViewed,
  type DecisionDeps,
} from '@aisdlc/decisions';
import { IdentityEligibility } from '@aisdlc/identity/read';
import { bindProject } from '@aisdlc/identity/testing';
import { newId, sha256Hex } from '@aisdlc/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemoryProofStore,
  PgProofStore,
  SignedStepUp,
  StepUpIssuer,
  decodeToken,
} from '../src/stepup/index.js';
import { signIn, startBffStack, type BffStack } from '../src/testing.js';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

// The point of M4.5 step-up: a REAL `StepUpPort` (`SignedStepUp`, verifying proofs the bff signed
// through kms-local, single-use in the bff schema) behind the decision kernel's `prepare`/`decide`.

let s: BffStack;
let deps: DecisionDeps;
let verifier: SignedStepUp;
let issuer: StepUpIssuer;
const pid = ProjectId.parse('acme');
const pr = (x: string) => PrincipalId.parse(x);

beforeAll(async () => {
  s = await startBffStack();
  await bindProject(s.identity, 'acme', {
    admin: ['alice'],
    requesters: ['bob'],
    intent: ['alice'],
    g5: ['alice'],
    m4: ['alice', 'carol'],
  });
  const pool = s.identity.record.pool;
  verifier = new SignedStepUp({
    custody: s.identity.kms.custodyFor('witness'), // verification needs only the public key
    store: new PgProofStore(pool),
    clock: s.identity.clock,
  });
  issuer = s.stepUp;
  deps = {
    pool,
    ledger: s.identity.ledger,
    eligibility: new IdentityEligibility({
      pool,
      settings: s.identity.settings,
      clock: s.identity.clock,
    }),
    stepUp: verifier,
    clock: s.identity.clock,
  };
});
afterAll(async () => {
  await s.stop();
});

const alice = pr('alice');
const bob = pr('bob');

/** A G5 (step-up kept) for a subject with this hash. Returns what `decide` needs. */
async function g5(
  subjectHash: string,
  over: { gate_id?: 'G5' | 'G2'; step_up_bound_hash?: string } = {},
) {
  const opened = await openGate(deps, {
    gate_id: over.gate_id ?? 'G5',
    project_id: pid,
    subject_kind: 'item',
    subject_id: newId<'WorkItem'>(),
    subject_hash: subjectHash,
    requester: bob,
    ...(over.step_up_bound_hash
      ? { step_up: true, step_up_bound_hash: over.step_up_bound_hash }
      : {}),
  });
  if (!opened.ok) throw new Error(`open: ${opened.error.message}`);
  return opened.value.gate_instance_id;
}

async function decideWith(gate: string, principal: PrincipalId, proof: string | null) {
  const p = await prepare(deps, { gate_instance_id: gate, principal });
  if (!p.ok) throw new Error(`prepare: ${p.error.message}`);
  const v = await recordEvidenceViewed(deps, {
    nonce: p.value.nonce,
    evidence_hash: p.value.evidence_hash,
  });
  if (!v.ok) throw new Error(`evidence: ${v.error.message}`);
  return {
    prepared: p.value,
    result: await decide(deps, {
      nonce: p.value.nonce,
      decision: 'approve',
      ...(proof === null ? {} : { step_up: { proof } }),
    }),
  };
}

const proofFor = async (
  principal: PrincipalId,
  hash: string,
  method: 'reauth' | 'reconfirm' = 'reauth',
) => {
  const r = await issuer.issue({
    principal,
    bound_hash: hash,
    method,
    auth_time: s.identity.clock.now(),
  });
  if (!r.ok) throw new Error(r.error);
  return r.value.proof;
};

describe('a decision that needs a step-up, with the real StepUpPort', () => {
  it('succeeds with a valid proof, and the ledger records what it was bound to (never the proof)', async () => {
    const H = sha256Hex('release-1');
    const gate = await g5(H);
    const proof = await proofFor(alice, H);
    const { prepared, result } = await decideWith(gate, alice, proof);
    expect(prepared.step_up).toEqual({ required: true, bound_hash: H });
    expect(result.ok).toBe(true);
    const body = JSON.stringify(result.ok && result.value.entry.body);
    expect(body).toContain(H);
    expect(body).toContain(sha256Hex(proof));
    expect(body).not.toContain(proof);
  });

  it('fails without a proof', async () => {
    const gate = await g5(sha256Hex('release-2'));
    const { result } = await decideWith(gate, alice, null);
    expect(!result.ok && result.error.code).toBe('step_up_required');
  });

  it('fails with an expired proof (five minutes), and expiry never approves', async () => {
    const H = sha256Hex('release-3');
    const gate = await g5(H);
    const proof = await proofFor(alice, H);
    s.identity.clock.advance(301_000);
    const { result } = await decideWith(gate, alice, proof);
    expect(!result.ok && result.error.code).toBe('step_up_invalid');
    expect(!result.ok && result.error.message).toMatch(/expired/);
  });

  it('is still valid just inside the five minutes', async () => {
    const H = sha256Hex('release-4');
    const gate = await g5(H);
    const proof = await proofFor(alice, H);
    s.identity.clock.advance(299_000);
    expect((await decideWith(gate, alice, proof)).result.ok).toBe(true);
  });

  it('fails with a replayed proof: single use, even for another gate with the same hash', async () => {
    const H = sha256Hex('release-5');
    const first = await g5(H);
    const proof = await proofFor(alice, H);
    expect((await decideWith(first, alice, proof)).result.ok).toBe(true);
    const second = await g5(H); // another item, same bound hash
    const { result } = await decideWith(second, alice, proof);
    expect(!result.ok && result.error.code).toBe('step_up_invalid');
    expect(!result.ok && result.error.message).toMatch(/already used/);
  });

  it('fails with a proof bound to another hash, without burning it for the right one', async () => {
    const H1 = sha256Hex('release-6a');
    const H2 = sha256Hex('release-6b');
    const gate1 = await g5(H1);
    const proofForH2 = await proofFor(alice, H2);
    const wrong = await decideWith(gate1, alice, proofForH2);
    expect(!wrong.result.ok && wrong.result.error.code).toBe('step_up_invalid');
    expect(!wrong.result.ok && wrong.result.error.message).toMatch(/another hash/);
    const gate2 = await g5(H2);
    expect((await decideWith(gate2, alice, proofForH2)).result.ok).toBe(true);
  });

  it('fails with a proof for another principal', async () => {
    const H = sha256Hex('release-7');
    const gate = await g5(H);
    const bobsProof = await proofFor(bob, H);
    const { result } = await decideWith(gate, alice, bobsProof);
    expect(!result.ok && result.error.code).toBe('step_up_invalid');
    expect(!result.ok && result.error.message).toMatch(/another principal/);
  });

  it('fails with a tampered proof (claims edited, signature kept)', async () => {
    const H = sha256Hex('release-8');
    const gate = await g5(H);
    const proof = await proofFor(bob, H);
    const [pre, payload, sig] = proof.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Json;
    claims.principal = 'alice';
    const forged = `${pre}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
    expect(decodeToken(forged)?.claims.principal).toBe('alice');
    const { result } = await decideWith(gate, alice, forged);
    expect(!result.ok && result.error.message).toMatch(/signature/);
  });

  it('fails with garbage, with a proof nobody issued, and with a proof signed by another key', async () => {
    const H = sha256Hex('release-9');
    const gate = await g5(H);
    expect((await decideWith(gate, alice, 'not-a-proof')).result.ok).toBe(false);
    // Signed by the real key but never registered in the ledger of issued proofs: unknown.
    const rogue = new StepUpIssuer({
      custody: s.identity.kms.custodyFor('bff'),
      store: new MemoryProofStore(),
      clock: s.identity.clock,
    });
    const r = await rogue.issue({
      principal: alice,
      bound_hash: H,
      method: 'reauth',
      auth_time: s.identity.clock.now(),
    });
    if (!r.ok) throw new Error(r.error);
    const unknown = await decideWith(gate, alice, r.value.proof);
    expect(!unknown.result.ok && unknown.result.error.message).toMatch(/not issued/);
    // A key that is not the step-up key cannot make a proof the verifier accepts.
    const other = new StepUpIssuer({
      custody: s.identity.kms.custodyFor('notary'),
      store: new PgProofStore(s.identity.record.pool),
      keyId: 'dev:notary',
      clock: s.identity.clock,
    });
    const o = await other.issue({
      principal: alice,
      bound_hash: H,
      method: 'reauth',
      auth_time: s.identity.clock.now(),
    });
    if (!o.ok) throw new Error(o.error);
    expect((await decideWith(gate, alice, o.value.proof)).result.ok).toBe(false);
  });

  it('refuses the DEC-11(c-ii) plain-confirm proof unless that fallback is allowed here', async () => {
    const H = sha256Hex('release-10');
    const gate = await g5(H);
    const weak = await proofFor(alice, H, 'reconfirm');
    const strict = await decideWith(gate, alice, weak);
    expect(!strict.result.ok && strict.result.error.message).toMatch(/reconfirm is not accepted/);
    // Allowed by configuration, the same kind of proof decides. (A new proof: the refusal above
    // did not burn the first, but this keeps the two cases independent.)
    const lenient = new SignedStepUp({
      custody: s.identity.kms.custodyFor('witness'),
      store: new PgProofStore(s.identity.record.pool),
      clock: s.identity.clock,
      allowedMethods: ['reauth', 'reconfirm'],
    });
    const lenientDeps = { ...deps, stepUp: lenient };
    const weak2 = await proofFor(alice, H, 'reconfirm');
    const p = await prepare(lenientDeps, { gate_instance_id: gate, principal: alice });
    if (!p.ok) throw new Error('prepare');
    await recordEvidenceViewed(lenientDeps, {
      nonce: p.value.nonce,
      evidence_hash: p.value.evidence_hash,
    });
    expect(
      (
        await decide(lenientDeps, {
          nonce: p.value.nonce,
          decision: 'approve',
          step_up: { proof: weak2 },
        })
      ).ok,
    ).toBe(true);
  });

  it('fails closed when the verification key cannot be fetched', async () => {
    const H = sha256Hex('release-11');
    const gate = await g5(H);
    const proof = await proofFor(alice, H);
    const blind = new SignedStepUp({
      custody: {
        publicKey: async () => ({
          ok: false,
          error: { _tag: 'KeyCustodyError', kind: 'unavailable', message: 'down' } as never,
        }),
      },
      store: new PgProofStore(s.identity.record.pool),
      clock: s.identity.clock,
    });
    const r = await blind.verify(proof, H as Sha256Hex, alice);
    expect(r.ok).toBe(false);
    // And the proof was not burnt by the failed verification.
    expect((await decideWith(gate, alice, proof)).result.ok).toBe(true);
  });
});

describe('end to end: a proof obtained through the bff API decides a gate bound to text_sha256 (D37)', () => {
  it('re-authenticate, collect the proof, decide', async () => {
    const text = sha256Hex('proposed AGENTS.md text, as shown on card 2');
    // G2 does not need a step-up by policy; the card opens it with one, bound to the text.
    const gate = await g5(sha256Hex('spec-1'), { gate_id: 'G2', step_up_bound_hash: text });
    const { browser } = await signIn(s, 'alice');
    const csrf = ((await (await browser.request(`${s.base}/api/me`)).json()) as Json)
      .csrf_token as string;
    const started = (await (
      await browser.request(`${s.base}/api/step-up`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ text_sha256: text }),
      })
    ).json()) as Json;
    await browser.follow(started.authorize_url);
    const got = (await (
      await browser.request(`${s.base}/api/step-up/${started.attempt_id}`)
    ).json()) as Json;
    const { prepared, result } = await decideWith(gate, alice, got.proof);
    expect(prepared.step_up).toEqual({ required: true, bound_hash: text });
    expect(result.ok).toBe(true);
    // The same proof cannot be used again, anywhere.
    const again = await g5(sha256Hex('spec-2'), { gate_id: 'G2', step_up_bound_hash: text });
    expect((await decideWith(again, alice, got.proof)).result.ok).toBe(false);
  });
});
