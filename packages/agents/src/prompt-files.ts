import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_SPECS } from './spec-data.js';

// Node-only side of the prompts (the registry itself never touches the file system, so a bundle does
// not need the files): reading them, hashing them and building `prompts.lock.json`. Used by the gen
// script and the tests, and by the agent runtime (M12, M13) to load the text it runs.

const here = new URL('./prompts/', import.meta.url);
export const PROMPTS_DIR = decodeURIComponent(here.pathname);
export const PROMPTS_LOCK_FORMAT = 'aisdlc-prompts-lock/v1';

export const promptFileName = (ref: string): string => `${ref}.md`;
export const readPrompt = (ref: string): string =>
  readFileSync(join(PROMPTS_DIR, promptFileName(ref)), 'utf8');
export const sha256File = (ref: string): string =>
  createHash('sha256')
    .update(readFileSync(join(PROMPTS_DIR, promptFileName(ref))))
    .digest('hex');
export const promptFilesOnDisk = (): string[] =>
  readdirSync(PROMPTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();

/**
 * The lock as it should be: every prompt the agent definitions name, with the sha256 of its file and
 * the contract version of the agents that use it. Two agents sharing a prompt must share a contract
 * version (the lock holds one).
 */
export function buildPromptsLock(): { format: string; prompts: Record<string, unknown> } {
  const prompts: Record<string, { file: string; sha256: string; contract_version: string }> = {};
  for (const s of AGENT_SPECS) {
    const prev = prompts[s.prompt];
    if (prev && prev.contract_version !== s.contract_version) {
      throw new Error(`${s.prompt} is shared by agents with different contract versions`);
    }
    prompts[s.prompt] = {
      file: promptFileName(s.prompt),
      sha256: sha256File(s.prompt),
      contract_version: s.contract_version,
    };
  }
  const sorted = Object.fromEntries(Object.entries(prompts).sort(([a], [b]) => a.localeCompare(b)));
  return { format: PROMPTS_LOCK_FORMAT, prompts: sorted };
}
