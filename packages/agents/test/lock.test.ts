import { describe, expect, it } from 'vitest';
import {
  PROMPTS_LOCK_FORMAT,
  buildPromptsLock,
  promptFileName,
  promptFilesOnDisk,
  sha256File,
} from '../src/prompt-files.js';
import { AGENT_SPECS } from '../src/spec-data.js';

// `prompts.lock.json` (PLAN M11.1; DM §3.5 PromptVersion): sha256 per prompt file and the contract
// version it belongs to. A prompt that changes without the lock being regenerated fails here:
//   npm run gen -w @aisdlc/agents      (rewrites the lock and generated/agents.json)
// The registry reads the lock, not the files, so the sha a run records is the sha that was reviewed.

describe('prompts.lock.json', () => {
  it('matches the prompt files and the agent definitions (regenerate with `npm run gen -w @aisdlc/agents`)', async () => {
    const text = `${JSON.stringify(buildPromptsLock(), null, 2)}\n`;
    await expect(text).toMatchFileSnapshot('../src/prompts/prompts.lock.json');
  });

  it('has a file for every prompt an agent names, and no prompt file nobody names', () => {
    const named = new Set(AGENT_SPECS.map((s) => promptFileName(s.prompt)));
    expect(promptFilesOnDisk()).toEqual([...named].sort());
  });

  it('uses the lock format and sha256 of the bytes on disk', async () => {
    const lock = buildPromptsLock();
    expect(lock.format).toBe(PROMPTS_LOCK_FORMAT);
    for (const s of AGENT_SPECS) expect(sha256File(s.prompt)).toMatch(/^[0-9a-f]{64}$/);
  });
});
