import { createHash, createHmac } from 'node:crypto';

// A minimal AWS Signature Version 4 signer for S3 (header form, path-style), over node:crypto. Only what
// `S3ObjectStore` needs; no SDK enters the tree. Pure: the clock is a parameter.

export interface SigV4Credentials {
  readonly accessKey: string;
  readonly secretKey: string;
}

export interface SignInput {
  readonly method: string;
  readonly url: URL;
  /** Extra headers to send and sign (lower-case names). `host` and the `x-amz-*` set below are added. */
  readonly headers: Readonly<Record<string, string>>;
  /** Hex sha256 of the body ('' hashes to the well-known empty digest). */
  readonly payloadSha256: string;
  readonly region: string;
  readonly now: Date;
  /** The AWS service the scope names. Default `s3` (`secretsmanager` for the AWS secret store). */
  readonly service?: string;
}

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();
export const sha256Of = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

/** RFC 3986 encoding of one path segment or query component (S3 canonical form). */
const enc = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export function canonicalQuery(url: URL): string {
  const pairs: Array<[string, string]> = [];
  url.searchParams.forEach((v, k) => pairs.push([enc(k), enc(v)]));
  pairs.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/** Returns the headers to send (including `authorization`, `x-amz-date`, `x-amz-content-sha256`). */
export function signV4(creds: SigV4Credentials, input: SignInput): Record<string, string> {
  const amzDate = input.now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    'x-amz-content-sha256': input.payloadSha256,
    'x-amz-date': amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((n) => `${n}:${(headers[n] ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = names.join(';');
  // url.pathname is already percent-encoded by WHATWG URL for what we send (keys are hex, buckets are [a-z0-9-]).
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    canonicalQuery(input.url),
    canonicalHeaders,
    signedHeaders,
    input.payloadSha256,
  ].join('\n');
  const service = input.service ?? 's3';
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Of(canonicalRequest)].join('\n');
  const kSigning = hmac(
    hmac(hmac(hmac(`AWS4${creds.secretKey}`, day), input.region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
