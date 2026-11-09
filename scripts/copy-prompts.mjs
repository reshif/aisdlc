// Copies the agents' locked prompt files next to a bundle (`dist/prompts/`), run from a workspace
// directory after `bundle.mjs`: node ../../scripts/copy-prompts.mjs
//
// A bundle holds code only, and `@aisdlc/agents/files` reads a prompt from `prompts/` beside the file it
// runs from. A service that runs agents (core-worker's planning port) needs the same bytes the registry
// locked (their sha256 is checked before a prompt is sent), so they are copied, never rewritten.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const from = resolve(import.meta.dirname, '..', 'packages', 'agents', 'src', 'prompts');
const to = join(process.cwd(), 'dist', 'prompts');
mkdirSync(to, { recursive: true });
for (const f of readdirSync(from)) {
  if (f.endsWith('.md')) copyFileSync(join(from, f), join(to, f));
}
