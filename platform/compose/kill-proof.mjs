// A step-up proof for one kill-switch act (RC-SEC-3), signed with the bff's key: what the bff issues
// after the person re-authenticated (`POST /api/step-up`, then `GET /api/step-up/:id`). Run INSIDE the
// bff container, which alone may use `dev:bff-stepup` at kms-local; the smoke test uses it to stand in for
// alice's and bob's sign-ins. Plain JavaScript (the image carries bundles, not the sources):
//
//   docker compose exec -T -e PRINCIPAL=alice -e ACT='{"action":"kill.release","kill_id":"..."}' \
//     bff node --input-type=module -e "$(cat kill-proof.mjs)"
//
// prints `su1.<claims>.<signature>`. The bound hash is contracts' `killActHash`:
// sha256(RFC 8785 JSON of {domain: "aisdlc/kill-act/1", ...act}); claims are `StepUpClaims`.
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';

// RFC 8785 for what these hold: objects, strings and small integers.
const canon = (v) =>
  v === null || typeof v !== 'object'
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(canon).join(',')}]`
      : `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
          .join(',')}}`;
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = (s) => createHash('sha256').update(s).digest();

const principal = process.env.PRINCIPAL;
const act = JSON.parse(process.env.ACT ?? 'null');
if (!principal || !act?.action) throw new Error('PRINCIPAL and ACT are needed');
const now = new Date();
const claims = {
  v: 1,
  proof_id: randomUUID(),
  principal,
  bound_hash: sha(canon({ domain: 'aisdlc/kill-act/1', ...act })).toString('hex'),
  method: 'reauth',
  auth_time: now.toISOString(),
  issued_at: now.toISOString(),
  expires_at: new Date(now.getTime() + 300_000).toISOString(),
};
const input = `su1.${b64u(canon(claims))}`;
const token = readFileSync(process.env.KMS_TOKEN_FILE ?? '/run/secrets/tok-bff-kms', 'utf8').trim();
const r = await fetch(
  `${process.env.KMS_URL ?? 'http://kms-local:8300'}/v1/keys/${encodeURIComponent('dev:bff-stepup')}/sign`,
  {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ digest: b64u(sha(input)) }),
  },
);
const body = await r.json();
if (r.status !== 200) throw new Error(`kms-local: ${r.status} ${JSON.stringify(body)}`);
console.log(`${input}.${body.signature}`);
