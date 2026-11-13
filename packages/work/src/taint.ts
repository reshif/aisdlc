import {
  TaintedText,
  type EntryChannel,
  type InjectionReport,
  type IntakeSource,
  type PrincipalId,
  type TaintOrigin,
  ENTRY_CHANNEL_SOURCES,
  DEFAULT_WORK_REQUEST,
  SETTINGS_KEYS,
  settingInForce,
} from '@aisdlc/contracts';
import { err, ok, sha256Hex, type Result } from '@aisdlc/kernel';
import { scanForInjection } from './injection.js';

// S1 step 1.1: normalise and taint-mark input (FL; FIX 15). Text that comes from outside the factory
// (a request, an answer to a question, an issue, a repo file) is DATA: it is normalised so that
// look-alike and invisible characters cannot hide a phrase from a scan or from a reader, it is marked
// `taint: 'untrusted'` with its provenance, and it keeps that mark wherever it goes. Pure: the same
// bytes always give the same text, hashes and flags.

/** Zero-width, soft-hyphen and bidi-control characters, and the other C0/C1 controls but tab and newline. */
/* eslint-disable no-control-regex -- removing control characters is the point */
const INVISIBLE = new RegExp(
  '[\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufeff]|[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]',
  'g',
);
/* eslint-enable no-control-regex */

/** A request is a few paragraphs, not a document: longer is refused, not truncated. */
export const MAX_REQUEST_TEXT_CHARS = DEFAULT_WORK_REQUEST.max_text_chars;

/**
 * The text as the factory keeps it: compatibility-folded (NFKC), invisible and control characters
 * removed, line ends as `\n`, trailing space cut, surrounding blank lines cut, runs of blank lines
 * squeezed to one.
 */
export function normaliseText(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/\r\n|\r|\u2028|\u2029/g, '\n')
    .replace(INVISIBLE, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The form two texts are compared in (1.2 de-dupe): normalised, lower-cased, every run of white
 * space one space. Two requests that differ only in case, spacing or invisible characters are the
 * same request.
 */
export const comparisonForm = (text: string): string =>
  normaliseText(text).toLowerCase().replace(/\s+/g, ' ');

/** sha256 of the comparison form: "the normalised text hash" of the de-dupe rule. */
export const normalisedTextHash = (text: string): string => sha256Hex(comparisonForm(text));

export type IntakeRefusalCode = 'empty' | 'too_long' | 'holds_secret' | 'channel_not_open';
export interface IntakeRefusal {
  readonly code: IntakeRefusalCode;
  readonly message: string;
}

export interface TaintInput {
  readonly raw: string;
  readonly channel: EntryChannel;
  readonly submitted_by: PrincipalId;
  readonly received_at: string;
  readonly origin?: TaintOrigin;
}

/**
 * 1.1: the text of a request, normalised and taint-marked, with the injection flags of the shared
 * lint. A text that holds a secret is refused (it would be copied into the record and onto cards,
 * and the record is permanent); every other finding only flags the text: it is fenced as data and
 * shown on the G0 card (B27), it never refuses or reroutes the request.
 */
export function taintMark(i: TaintInput): Result<TaintedText, IntakeRefusal> {
  const text = normaliseText(i.raw);
  if (text === '') return err({ code: 'empty', message: 'the request has no text' });
  // portal v2 (`work.request`, H26): the factory's limit in force
  const max = settingInForce(SETTINGS_KEYS.work_request, DEFAULT_WORK_REQUEST).max_text_chars;
  if (text.length > max) {
    return err({
      code: 'too_long',
      message: `the request is longer than ${max} characters`,
    });
  }
  const scan = scanForInjection(text);
  if (scan.holds_secret) {
    return err({ code: 'holds_secret', message: 'the request text holds a secret: remove it' });
  }
  return ok(
    TaintedText.parse({
      text,
      taint: 'untrusted',
      origin: i.origin ?? 'request',
      provenance: {
        channel: i.channel,
        source: ENTRY_CHANNEL_SOURCES[i.channel],
        received_at: i.received_at,
        submitted_by: i.submitted_by,
        raw_sha256: sha256Hex(i.raw),
        normalised_sha256: normalisedTextHash(text),
      },
      flags: scan.flags,
    }),
  );
}

// ---------------------------------------------------------------- Fencing

/**
 * The text as a reader or an agent is shown it: inside a block that says what it is, where it came
 * from and its hash, with any look-alike of the block's own delimiter in the text made harmless. The
 * block is DATA; nothing in it is an instruction to the reader.
 */
export function fenceAsData(t: TaintedText): string {
  const head = `<<<UNTRUSTED-DATA origin=${t.origin} channel=${t.provenance.channel} sha256=${t.provenance.normalised_sha256}>>>`;
  const tail = `<<<END-UNTRUSTED-DATA sha256=${t.provenance.normalised_sha256}>>>`;
  const safe = t.text.replaceAll('<<<', '&lt;&lt;&lt;').replaceAll('>>>', '&gt;&gt;&gt;');
  return `${head}\n${safe}\n${tail}`;
}

/** What the G0 card carries about a text: the scan result and the hash of the block the card shows. */
export function injectionReportOf(t: TaintedText): InjectionReport {
  return {
    suspected: t.flags.length > 0,
    rules: [...new Set(t.flags.map((f) => f.rule))].sort() as InjectionReport['rules'],
    lines: [...new Set(t.flags.map((f) => f.line))].sort((a, b) => a - b),
    text_sha256: sha256Hex(fenceAsData(t)),
  };
}

export type { IntakeSource };
