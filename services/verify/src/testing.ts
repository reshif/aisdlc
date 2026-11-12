import { randomBytes } from 'node:crypto';
import { readPrompt } from '@aisdlc/agents/files';
import type { SandboxPort } from '@aisdlc/ports';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import {
  HttpVerify,
  NoHoldouts,
  VerifyRunner,
  type HoldoutPort,
  type RepoFilesPort,
  type ReviewerPort,
} from '@aisdlc/verify';
import type pg from 'pg';
import { createVerifyApp, type VerifyScope } from './app.js';
import { VerifyService } from './service.js';

export interface TestVerify {
  readonly url: string;
  /** core-worker's token (scopes run, read). */
  readonly token: string;
  readonly client: HttpVerify;
  close(): Promise<void>;
}

/** The verify service on a loopback port over `pool` (migrated), with the ports a test hands it. */
export async function startTestVerify(o: {
  pool: pg.Pool;
  sandbox: SandboxPort;
  files: RepoFilesPort;
  reviewer: ReviewerPort;
  holdouts?: HoldoutPort;
  scopes?: readonly VerifyScope[];
}): Promise<TestVerify> {
  const token = randomBytes(24).toString('hex');
  const runner = new VerifyRunner({
    sandbox: o.sandbox,
    files: o.files,
    reviewer: o.reviewer,
    holdouts: o.holdouts ?? new NoHoldouts(),
    prompt: readPrompt,
  });
  const app = createVerifyApp({
    service: new VerifyService({ pool: o.pool, runner }),
    pool: o.pool,
    auth: new ServiceAuth({ 'core-worker': token }),
    callers: { 'core-worker': o.scopes ?? ['run', 'read'] },
  });
  const url = await listen(app);
  return { url, token, client: new HttpVerify({ baseUrl: url, token }), close: () => app.close() };
}
