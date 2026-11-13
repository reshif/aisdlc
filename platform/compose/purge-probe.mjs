// smoke.sh's probe of the deletion's object-store credential, run inside core (the one service that mounts it): the
// three requests `S3ObjectStore.purge` sends (list the object's versions, lift each version's legal hold, delete the
// version), plus a read and a write that must be refused. SigV4 by hand (node's crypto only) so the probe sends exactly
// those requests and nothing else (`mc` would also ask the bucket's location and lock settings, which the credential
// does not hold). Env BUCKET and KEY; smoke.sh passes it with `node --input-type=module -e` as it does kill-proof.mjs.
// Prints one line per request; exits 1 on a surprise.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const bucket = process.env.BUCKET ?? '';
const key = process.env.KEY ?? '';
const ak = readFileSync('/run/secrets/object-store-purge-access-key', 'utf8').trim();
const sk = readFileSync('/run/secrets/object-store-purge-secret-key', 'utf8').trim();
const host = 'object-store:9000';
const region = 'us-east-1';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();

async function s3(method, path, query = '', body = '', extra = {}) {
  const now = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const day = now.slice(0, 8);
  const headers = { host, 'x-amz-date': now, 'x-amz-content-sha256': sha(body), ...extra };
  const names = Object.keys(headers).sort();
  const canonQuery = query
    .split('&')
    .filter(Boolean)
    .map((p) => (p.includes('=') ? p : `${p}=`))
    .sort()
    .join('&');
  const canon = [
    method,
    path,
    canonQuery,
    ...names.map((n) => `${n}:${headers[n]}`),
    '',
    names.join(';'),
    headers['x-amz-content-sha256'],
  ].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha(canon)].join('\n');
  const kSign = hmac(hmac(hmac(hmac(`AWS4${sk}`, day), region), 's3'), 'aws4_request');
  const sig = createHmac('sha256', kSign).update(toSign).digest('hex');
  const auth = `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`;
  const r = await fetch(`http://${host}${path}${canonQuery ? `?${canonQuery}` : ''}`, {
    method,
    headers: { ...headers, authorization: auth },
    ...(body ? { body } : {}),
  });
  return { status: r.status, text: await r.text() };
}

const must = (ok, line) => {
  console.log(`  ${line}`);
  if (!ok) process.exit(1);
};
const get = await s3('GET', `/${bucket}/${key}`);
must(get.status === 403, `read the object: ${get.status} (refused)`);
const put = await s3('PUT', `/${bucket}/${key}-written`, '', 'x');
must(put.status === 403, `write an object: ${put.status} (refused)`);
const list = await s3('GET', `/${bucket}`, `prefix=${key}&versions`);
const ids = [...list.text.matchAll(/<VersionId>([^<]+)<\/VersionId>/g)].map((m) => m[1]);
must(list.status === 200 && ids.length > 0, `list its versions: ${list.status}, ${ids.length}`);
for (const id of ids) {
  const xml =
    '<LegalHold xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>OFF</Status></LegalHold>';
  const md5 = createHash('md5').update(xml).digest('base64');
  const off = await s3('PUT', `/${bucket}/${key}`, `legal-hold&versionId=${id}`, xml, {
    'content-md5': md5,
    'content-type': 'application/xml',
  });
  must(off.status === 200, `lift the legal hold of a version: ${off.status}`);
  const del = await s3('DELETE', `/${bucket}/${key}`, `versionId=${id}`);
  must(del.status === 204, `delete the version: ${del.status}`);
}
