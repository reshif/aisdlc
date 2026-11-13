// A line diff of two texts (the Documents tab's "what changed between versions", P2-1): the longest common
// subsequence of lines, so every line is kept, added or removed exactly once. Pure and deterministic. Texts above
// MAX_CELLS of comparisons are not diffed (`null`): the page says so rather than freezing the browser.

export interface DiffLine {
  readonly op: 'same' | 'add' | 'del';
  readonly text: string;
}

const MAX_CELLS = 4_000_000;

export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split('\n');
  const b = after.split('\n');
  // the common head and tail need no table
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  if ((x.length + 1) * (y.length + 1) > MAX_CELLS) return null;
  // lcs[i][j]: the LCS length of x[i..] and y[j..]
  const w = y.length + 1;
  const lcs = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i * w + j] =
        x[i] === y[j]
          ? (lcs[(i + 1) * w + j + 1] as number) + 1
          : Math.max(lcs[(i + 1) * w + j] as number, lcs[i * w + j + 1] as number);
    }
  }
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ op: 'same', text }));
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ op: 'same', text: x[i] as string });
      i += 1;
      j += 1;
    } else if ((lcs[(i + 1) * w + j] as number) >= (lcs[i * w + j + 1] as number)) {
      out.push({ op: 'del', text: x[i] as string });
      i += 1;
    } else {
      out.push({ op: 'add', text: y[j] as string });
      j += 1;
    }
  }
  for (; i < x.length; i++) out.push({ op: 'del', text: x[i] as string });
  for (; j < y.length; j++) out.push({ op: 'add', text: y[j] as string });
  for (const text of a.slice(a.length - tail)) out.push({ op: 'same', text });
  return out;
}
