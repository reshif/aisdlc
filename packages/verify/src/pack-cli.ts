import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { checkSignedEvidencePack } from '@aisdlc/contracts';
import { sha256Hex, type Jwk } from '@aisdlc/kernel';

// `aisdlc-verify-pack` (PLAN M14.4): checks a signed Evidence Pack offline. Given the bytes (a file saved from the
// object store, or the object itself) and the Notary's PUBLIC key, it checks the canonical form, the object key, the
// pack hash, the Notary's signature and that the pack is bound to the head SHA the caller names. No network, no
// database: the same function (`checkSignedEvidencePack` in contracts) gate-check will run.

export interface PackCliIo {
  out(line: string): void;
  err(line: string): void;
}

export const VERIFY_PACK_USAGE = `usage: aisdlc-verify-pack --pack <file> --notary-key <jwk-file> --head <sha> [--item <id>] [--object-key <sha256>] [--allow-not-passing]

Verifies a signed Evidence Pack offline: the bytes are canonical JSON (RFC 8785), they hash to the object key (when
given; else the key printed is theirs), the pack hashes to its pack_sha256, the Notary signed that id under the given
public key, and the pack is bound to --head (and --item). A pack that is not passing (rework, a D2 handoff) fails
unless --allow-not-passing.
Exit code 0: verified. 1: verification failed (the reason printed). 2: bad usage or unreadable input.
  --pack               the signed pack's bytes (as stored in the object store)
  --notary-key         public JWK of the Notary key
  --head               the 40-hex head SHA the pack must be bound to (the PR head)
  --item               the work item id the pack must be for
  --object-key         the object store key (sha256 of the bytes) it was read under
  --allow-not-passing  accept a signed pack whose disposition is not a pass (to read a D2's evidence)`;

class UsageError extends Error {}

function readPublicJwk(path: string): Jwk {
  let jwk: Record<string, unknown>;
  try {
    jwk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    throw new UsageError(
      `cannot read notary key ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (
    jwk['kty'] !== 'EC' ||
    jwk['crv'] !== 'P-256' ||
    typeof jwk['x'] !== 'string' ||
    typeof jwk['y'] !== 'string'
  ) {
    throw new UsageError(`notary key ${path} is not a P-256 EC public JWK`);
  }
  if ('d' in jwk)
    throw new UsageError(`notary key ${path} contains a private key; give the public JWK only`);
  return jwk as Jwk;
}

/** Runs the CLI and returns the exit code. */
export async function verifyPackMain(argv: readonly string[], io: PackCliIo): Promise<number> {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        pack: { type: 'string' },
        'notary-key': { type: 'string' },
        head: { type: 'string' },
        item: { type: 'string' },
        'object-key': { type: 'string' },
        'allow-not-passing': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    });
    if (values.help) {
      io.out(VERIFY_PACK_USAGE);
      return 0;
    }
    if (!values.pack || !values['notary-key'] || !values.head) {
      throw new UsageError('--pack, --notary-key and --head are required');
    }
    if (!/^[0-9a-f]{40}$/.test(values.head))
      throw new UsageError('--head is not a 40-hex commit sha');
    if (values['object-key'] !== undefined && !/^[0-9a-f]{64}$/.test(values['object-key'])) {
      throw new UsageError('--object-key is not a sha256');
    }
    const key = readPublicJwk(values['notary-key']);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(values.pack));
    } catch (e) {
      throw new UsageError(
        `cannot read pack ${values.pack}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const r = await checkSignedEvidencePack(bytes, key, {
      head_sha: values.head,
      ...(values.item !== undefined ? { item_id: values.item } : {}),
      ...(values['object-key'] !== undefined ? { object_key: values['object-key'] } : {}),
      require_passing: values['allow-not-passing'] !== true,
    });
    if (!r.ok) {
      io.err(`verify-pack FAILED [${r.code}]: ${r.message}`);
      return 1;
    }
    const p = r.signed.pack;
    io.out(
      `evidence pack OK: ${r.signed.pack_sha256} (object ${sha256Hex(bytes)}), signed by ${r.signed.signature.key_id}`,
    );
    io.out(
      `item ${p.item_id} ${p.repo} head ${p.head_sha} base ${p.base_sha}: ${p.passing ? 'passing' : `NOT passing (${p.disposition.kind})`}; ${p.steps.filter((s) => s.met).length}/${p.steps.length} steps met`,
    );
    return 0;
  } catch (e) {
    if (e instanceof UsageError || (e instanceof TypeError && 'code' in e)) {
      io.err(`aisdlc-verify-pack: ${e.message}\n${VERIFY_PACK_USAGE}`);
      return 2;
    }
    io.err(`verify-pack could not run: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}
