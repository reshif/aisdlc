// Docker's multiplexed log stream: frames of an 8-byte header (stream type, three zero bytes, big-endian size)
// and a payload. Demultiplexed with a cap per stream; a frame header that does not look like one ends the read.

export interface Demuxed {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  /** A stream passed its cap and the rest was dropped. */
  readonly truncated: boolean;
  /** The bytes were not a frame stream (a TTY container would give raw text; ours are never TTYs). */
  readonly malformed: boolean;
}

export function demux(raw: Buffer, capPerStream: number): Demuxed {
  const out: Buffer[][] = [[], []];
  const sizes = [0, 0];
  let truncated = false;
  let malformed = false;
  let off = 0;
  while (off + 8 <= raw.length) {
    const type = raw[off] ?? 9;
    if (
      (type !== 1 && type !== 2 && type !== 0) ||
      raw[off + 1] !== 0 ||
      raw[off + 2] !== 0 ||
      raw[off + 3] !== 0
    ) {
      malformed = true;
      break;
    }
    const len = raw.readUInt32BE(off + 4);
    const end = Math.min(raw.length, off + 8 + len);
    if (type === 1 || type === 2) {
      const i = type - 1;
      const room = capPerStream - (sizes[i] as number);
      const take = Math.max(0, Math.min(room, end - off - 8));
      if (take < end - off - 8) truncated = true;
      if (take > 0) {
        (out[i] as Buffer[]).push(raw.subarray(off + 8, off + 8 + take));
        sizes[i] = (sizes[i] as number) + take;
      }
    }
    off = end;
  }
  if (off < raw.length && !malformed) malformed = true;
  return {
    stdout: Buffer.concat(out[0] as Buffer[]),
    stderr: Buffer.concat(out[1] as Buffer[]),
    truncated,
    malformed,
  };
}

export interface OutBlock {
  readonly exit_code: number;
  /** The decoded tar. */
  readonly tar: Buffer;
  /** stdout with the block taken out. */
  readonly stdout: Buffer;
}

/**
 * The block the wrapper writes at the end: `<mark> BEGIN exit=N`, base64 lines, `<mark> END`. The LAST begin
 * that has an end after it is the one used. Null when there is none (the wrapper never got to print it).
 */
export function extractOutBlock(stdout: Buffer, mark: string): OutBlock | null {
  const begin = Buffer.from(`\n${mark} BEGIN exit=`);
  const end = Buffer.from(`\n${mark} END\n`);
  let from = stdout.length;
  for (;;) {
    const b = from <= 0 ? -1 : stdout.lastIndexOf(begin, from - 1);
    if (b < 0) return null;
    const lineEnd = stdout.indexOf(0x0a, b + begin.length);
    const e = lineEnd < 0 ? -1 : stdout.indexOf(end, lineEnd);
    if (lineEnd >= 0 && e >= 0) {
      const code = Number(stdout.subarray(b + begin.length, lineEnd).toString('latin1'));
      if (Number.isInteger(code) && code >= 0 && code <= 255) {
        const b64 = stdout
          .subarray(lineEnd + 1, e)
          .toString('latin1')
          .replace(/[^A-Za-z0-9+/=]/g, '');
        return {
          exit_code: code,
          tar: Buffer.from(b64, 'base64'),
          stdout: Buffer.concat([stdout.subarray(0, b), stdout.subarray(e + end.length)]),
        };
      }
    }
    from = b;
  }
}
