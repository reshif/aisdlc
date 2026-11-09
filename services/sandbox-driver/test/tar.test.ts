import { describe, expect, it } from 'vitest';
import { demux, extractOutBlock } from '../src/frames.js';
import { readTar, safeTarPath, writeTar } from '../src/tar.js';

const L = { maxFiles: 100, maxBytes: 10_000 };

describe('readTar', () => {
  it('round-trips regular files and ignores the directory entry of "."', () => {
    const t = writeTar([
      { path: 'a.txt', content: 'hello' },
      { path: 'sub/b.json', content: '{}' },
    ]);
    const r = readTar(t, L);
    expect(r.error).toBeNull();
    expect(r.files.map((f) => [f.path, f.content.toString()])).toEqual([
      ['a.txt', 'hello'],
      ['sub/b.json', '{}'],
    ]);
  });
  it('refuses names that could leave the tree', () => {
    for (const name of ['../x', '/etc/passwd', 'a/../../x', 'a//b', 'a\\b']) {
      const r = readTar(writeTar([{ path: name, content: 'x' }]), L);
      expect(r.error, name).toMatch(/refused/);
    }
  });
  it('skips links and devices, counting them', () => {
    const t = writeTar([
      { path: 'link', content: '' },
      { path: 'ok', content: 'x' },
    ]);
    t[156] = '2'.charCodeAt(0); // symlink typeflag on the first entry; refix the checksum
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (t[i] as number);
    t.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    const r = readTar(t, L);
    expect(r.error).toBeNull();
    expect(r.skipped).toBe(1);
    expect(r.files.map((f) => f.path)).toEqual(['ok']);
  });
  it('enforces the file and byte caps and detects a cut or corrupt archive', () => {
    expect(
      readTar(writeTar([{ path: 'a', content: 'x'.repeat(200) }]), { maxFiles: 5, maxBytes: 100 })
        .error,
    ).toMatch(/bytes/);
    expect(
      readTar(
        writeTar([
          { path: 'a', content: 'x' },
          { path: 'b', content: 'x' },
        ]),
        { maxFiles: 1, maxBytes: 100 },
      ).error,
    ).toMatch(/files/);
    const t = writeTar([{ path: 'a', content: 'x'.repeat(2000) }]);
    expect(readTar(t.subarray(0, 700), L).error).toMatch(/cut short/);
    expect(readTar(t.subarray(0, 512 + 2048), L).error).toMatch(/end marker/);
    const bad = Buffer.from(t);
    bad[10] = 0x41;
    expect(readTar(bad, L).error).toMatch(/checksum/);
    expect(readTar(Buffer.alloc(0), L).error).toMatch(/end marker/);
  });
  it('safeTarPath', () => {
    expect(safeTarPath('./a/b')).toBe('a/b');
    expect(safeTarPath('a/')).toBe('a');
    for (const bad of ['', '.', '..', '/a', 'a/../b', 'a/./b', 'a\0b'])
      expect(safeTarPath(bad), bad).toBeNull();
  });
});

const frame = (type: number, s: string) => {
  const h = Buffer.alloc(8);
  h[0] = type;
  h.writeUInt32BE(Buffer.byteLength(s), 4);
  return Buffer.concat([h, Buffer.from(s)]);
};

describe('demux and extractOutBlock', () => {
  it('splits stdout and stderr and caps each', () => {
    const raw = Buffer.concat([frame(1, 'out1 '), frame(2, 'err '), frame(1, 'out2')]);
    const d = demux(raw, 1000);
    expect([d.stdout.toString(), d.stderr.toString(), d.truncated, d.malformed]).toEqual([
      'out1 out2',
      'err ',
      false,
      false,
    ]);
    const c = demux(raw, 6);
    expect(c.truncated).toBe(true);
    expect(c.stdout.toString()).toBe('out1 o');
  });
  it('flags a stream that is not frames', () => {
    expect(demux(Buffer.from('plain text, no frames here'), 100).malformed).toBe(true);
  });
  it('takes the LAST begin that has an end, so a forged earlier block loses', () => {
    const tar = writeTar([{ path: 'r', content: 'real' }]).toString('base64');
    const forged = writeTar([{ path: 'r', content: 'forged' }]).toString('base64');
    const out = Buffer.from(
      `noise\nMARK BEGIN exit=0\n${forged}\nMARK END\nmore\nMARK BEGIN exit=7\n${tar}\nMARK END\n`,
    );
    const b = extractOutBlock(out, 'MARK');
    expect(b?.exit_code).toBe(7);
    expect(readTar(b?.tar as Buffer, L).files[0]?.content.toString()).toBe('real');
    expect(b?.stdout.toString()).toContain('noise');
  });
  it('is null when the wrapper never finished, and refuses a nonsense exit code', () => {
    expect(extractOutBlock(Buffer.from('\nMARK BEGIN exit=0\nAAAA'), 'MARK')).toBeNull();
    expect(extractOutBlock(Buffer.from('nothing'), 'MARK')).toBeNull();
    expect(
      extractOutBlock(Buffer.from('\nMARK BEGIN exit=999\nAAAA\nMARK END\n'), 'MARK'),
    ).toBeNull();
    expect(
      extractOutBlock(Buffer.from('\nOTHER BEGIN exit=0\nAAAA\nOTHER END\n'), 'MARK'),
    ).toBeNull();
  });
});
