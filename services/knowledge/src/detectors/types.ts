import type {
  CoverageItem,
  DetectorEvidence,
  DetectorId,
  DetectorInfo,
  Fact,
  GitSha,
} from '@aisdlc/contracts';

// The detector interface (PLAN M6.3). A detector is a pure function over a tree reader: it reads
// blobs of the head tree through the reader (the hardened git object reader, never a checkout),
// parses them with safe parsers only, and returns facts with evidence plus coverage items for what
// it could not read or parse. It has no other input and no side effect. Nothing it reads is ever
// executed, and nothing it reads is ever treated as guidance.

/** One blob of the head tree (a symlink is a blob too: its content is the link target, never followed). */
export interface TreeFile {
  readonly path: string;
  readonly blob: GitSha;
  readonly mode: string;
  readonly size: number;
}

export type ReadOutcome =
  /** `text` is decoded as UTF-8 (invalid bytes become U+FFFD; the lint also sees them as text). */
  | { readonly state: 'ok'; readonly file: TreeFile; readonly text: string }
  | { readonly state: 'absent' }
  | { readonly state: 'symlink'; readonly file: TreeFile; readonly target: string }
  | { readonly state: 'too_large'; readonly file: TreeFile; readonly limit: number }
  | { readonly state: 'unreadable'; readonly file: TreeFile };

export interface TreeReader {
  /** Every blob of the head tree, by path. Submodule entries are not here (the scan lists them). */
  readonly files: readonly TreeFile[];
  get(path: string): TreeFile | undefined;
  /** Files whose path starts with `prefix` (a directory prefix ends with `/`). */
  under(prefix: string): TreeFile[];
  /**
   * Reads one blob as text. A blob over `maxBytes` (default: the job's per-file cap) is `too_large`
   * and is not read at all. A git failure on the object is `unreadable`; a process-level failure
   * (the job deadline, git dying) throws, and the detector is recorded as failed.
   */
  readText(path: string, maxBytes?: number): Promise<ReadOutcome>;
  /** The branch the head belongs to (for apply-on-merge); `null` if it cannot be told. */
  readonly defaultBranch: string | null;
  /** The job's per-file cap, the default for `readText`. */
  readonly maxFileBytes: number;
}

export interface DetectorOutput {
  readonly facts: Fact[];
  readonly coverage: CoverageItem[];
  /** Complete counts a detector reports beyond its (capped) facts: `workflows_unanalysed`, lint counts. */
  readonly stats: Record<string, number>;
}

export interface Detector {
  readonly info: DetectorInfo;
  run(reader: TreeReader): Promise<DetectorOutput>;
}

/** Accumulates one detector's output and turns every read problem into a coverage item. */
export class Collector {
  readonly facts: Fact[] = [];
  readonly coverage: CoverageItem[] = [];
  readonly stats: Record<string, number> = {};
  constructor(
    readonly detector: DetectorId,
    private readonly reader: TreeReader,
  ) {}

  add(f: Fact): void {
    this.facts.push(f);
  }

  cover(item: CoverageItem): void {
    this.coverage.push(item);
  }

  /** The file's text, or `null` with the reason recorded (never a silent skip). */
  async text(path: string, maxBytes?: number): Promise<{ file: TreeFile; text: string } | null> {
    const r = await this.reader.readText(path, maxBytes);
    switch (r.state) {
      case 'ok':
        return { file: r.file, text: r.text };
      case 'absent':
        return null;
      case 'symlink':
        return null;
      case 'too_large':
        this.cover({
          kind: r.limit >= this.reader.maxFileBytes ? 'file_over_cap' : 'parse_limit',
          path: r.file.path,
          object: r.file.blob,
          reason: `${r.file.size} bytes is over the ${r.limit}-byte limit for ${this.detector}: not read`,
        });
        return null;
      case 'unreadable':
        this.cover({
          kind: 'unreadable_object',
          path: r.file.path,
          object: r.file.blob,
          reason: `git could not read this object for ${this.detector}`,
        });
        return null;
    }
  }

  /** A file that could not be parsed: its facts are missing, which is recorded, not guessed. */
  unparseable(file: TreeFile, why: string): void {
    this.cover({
      kind: why.startsWith('limit:') ? 'parse_limit' : 'unparseable_file',
      path: file.path,
      object: file.blob,
      reason: `${this.detector}: ${why.replace(/^limit:\s*/, '')}`.slice(0, 500),
    });
  }

  /** The detector reached its file-count cap: the heuristic saw only part of the tree. */
  capped(what: string, limit: number): void {
    this.cover({
      kind: 'detector_cap',
      path: null,
      object: null,
      reason: `${this.detector}: stopped at ${limit} ${what}; the rest were not looked at`,
    });
  }

  evidence(file: TreeFile, line = 1): DetectorEvidence {
    return { path: file.path, blob: file.blob, line };
  }

  output(): DetectorOutput {
    return { facts: this.facts, coverage: this.coverage, stats: this.stats };
  }
}

/** 1-based line of a character offset. */
export function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

/** 1-based line of the first line containing `needle`, or 1. */
export function lineOfText(text: string, needle: string): number {
  const i = text.indexOf(needle);
  return i === -1 ? 1 : lineOfOffset(text, i);
}

export const dirname = (p: string): string =>
  p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
export const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
