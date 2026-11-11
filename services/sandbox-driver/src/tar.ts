// A small, strict tar reader for what comes out of a sandbox's `/out` (PLAN M13.2). The bytes are the word of
// code the factory does not trust, so the reader reads regular files only, never follows or creates anything,
// refuses names that could leave the tree, and stops at the caps. It reads POSIX ustar, GNU long names and pax
// path records (what GNU tar writes); every other entry kind (symlink, hard link, device, fifo) is counted and
// skipped, never materialised.

export interface TarFile {
  readonly path: string;
  readonly content: Buffer;
}

export interface TarResult {
  readonly files: TarFile[];
  /** Entries that were not regular files or directories (links, devices, fifos): counted, never used. */
  readonly skipped: number;
  /** The archive is cut short, malformed, or holds more than the caps allow: the caller treats the whole run as void. */
  readonly error: string | null;
}

export interface TarLimits {
  readonly maxFiles: number;
  /** Total bytes of file content. */
  readonly maxBytes: number;
}

const octal = (b: Buffer): number | null => {
  if ((b[0] ?? 0) & 0x80) {
    // base-256 (GNU): big-endian, high bit marks the form
    let n = (b[0] ?? 0) & 0x7f;
    for (let i = 1; i < b.length; i++) n = n * 256 + (b[i] ?? 0);
    return Number.isSafeInteger(n) ? n : null;
  }
  const s = b.toString('latin1').replace(/\0.*$/s, '').trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) return null;
  return parseInt(s, 8);
};
const cstr = (b: Buffer): string => b.toString('utf8').replace(/\0.*$/s, '');

/** A name that stays inside the tree: relative, no `..`, no empty or `.` parts, no backslash or NUL. */
export function safeTarPath(raw: string): string | null {
  let p = raw;
  while (p.startsWith('./')) p = p.slice(2);
  if (p === '' || p === '.') return null;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0') || p.length > 1024) return null;
  const parts = p.replace(/\/+$/, '').split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return null;
  return parts.join('/');
}

function paxPath(data: Buffer): { path?: string; size?: number } {
  const out: { path?: string; size?: number } = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number(data.subarray(i, sp).toString('latin1'));
    if (!Number.isInteger(len) || len <= 0 || i + len > data.length) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) {
      const k = rec.slice(0, eq);
      const v = rec.slice(eq + 1);
      if (k === 'path') out.path = v;
      if (k === 'size' && /^[0-9]+$/.test(v)) out.size = Number(v);
    }
    i += len;
  }
  return out;
}

export function readTar(buf: Buffer, limits: TarLimits): TarResult {
  const files = new Map<string, Buffer>();
  let skipped = 0;
  let total = 0;
  let off = 0;
  let longName: string | null = null;
  let pax: { path?: string; size?: number } | null = null;
  const fail = (error: string): TarResult => ({
    files: [...files].map(([path, content]) => ({ path, content })),
    skipped,
    error,
  });
  let sawEnd = false;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) {
      sawEnd = true;
      break;
    }
    // checksum: the sum of the header with the checksum field taken as spaces
    const want = octal(h.subarray(148, 156));
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] ?? 0);
    if (want === null || want !== sum) return fail('bad tar header checksum');
    let size = octal(h.subarray(124, 136));
    if (size === null) return fail('bad tar size');
    const type = String.fromCharCode(h[156] ?? 0x30);
    const magic = h.subarray(257, 262).toString('latin1');
    let name = cstr(h.subarray(0, 100));
    if (magic === 'ustar') {
      const prefix = cstr(h.subarray(345, 500));
      if (prefix !== '') name = `${prefix}/${name}`;
    }
    off += 512;
    if (pax?.size !== undefined && (type === '0' || type === '\0')) size = pax.size;
    if (off + size > buf.length) return fail('tar is cut short');
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = cstr(data);
      continue;
    }
    if (type === 'x') {
      pax = paxPath(data);
      continue;
    }
    if (type === 'g') continue;
    const useName = pax?.path ?? longName ?? name;
    pax = null;
    longName = null;
    if (type === '5') continue;
    if (type !== '0' && type !== '\0') {
      skipped += 1;
      continue;
    }
    const path = safeTarPath(useName);
    if (path === null)
      return fail(`tar entry name refused: ${JSON.stringify(useName).slice(0, 60)}`);
    if (!files.has(path) && files.size >= limits.maxFiles)
      return fail(`more than ${limits.maxFiles} files`);
    total += size - (files.get(path)?.length ?? 0);
    if (total > limits.maxBytes) return fail(`more than ${limits.maxBytes} bytes`);
    files.set(path, Buffer.from(data));
  }
  if (!sawEnd) return fail('tar has no end marker');
  return { files: [...files].map(([path, content]) => ({ path, content })), skipped, error: null };
}

/** A minimal ustar writer for the tests (and for a repo copy shipped as one archive). Regular files only. */
export function writeTar(
  files: ReadonlyArray<{ path: string; content: Buffer | string; mode?: number }>,
): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const content = typeof f.content === 'string' ? Buffer.from(f.content) : f.content;
    const h = Buffer.alloc(512);
    const name = Buffer.from(f.path);
    if (name.length > 100) throw new Error('writeTar: name too long');
    name.copy(h, 0);
    h.write((f.mode ?? 0o644).toString(8).padStart(7, '0') + '\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(h, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
