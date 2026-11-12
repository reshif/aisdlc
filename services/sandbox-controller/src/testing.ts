import { randomBytes } from 'node:crypto';
import { HttpSandbox, type SandboxPort } from '@aisdlc/ports';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import { createControllerApp, type ControllerScope } from './app.js';
import { StaticCaps, type CapsReader } from './caps.js';
import { SandboxController } from './controller.js';
import { FakeGrants, type GrantVerifier } from './grants.js';

export interface TestController {
  readonly url: string;
  /** core-worker's token (scopes run, read). */
  readonly token: string;
  readonly controller: SandboxController;
  /** The adapter core uses, pointed at this controller. */
  readonly client: HttpSandbox;
  close(): Promise<void>;
}

/** A controller on a loopback port in front of `driver` (a `FakeSandbox` in tests), with fixed caps and fake grants by default. */
export async function startTestController(o: {
  driver: SandboxPort;
  caps?: CapsReader;
  grants?: GrantVerifier;
  reload?: () => Promise<void>;
  scopes?: readonly ControllerScope[];
}): Promise<TestController> {
  const token = randomBytes(24).toString('hex');
  const caps = o.caps ?? new StaticCaps();
  const controller = new SandboxController({
    driver: o.driver,
    caps,
    grants: o.grants ?? new FakeGrants(),
    hostId: 'test',
  });
  const app = createControllerApp({
    controller,
    auth: new ServiceAuth({ 'core-worker': token }),
    callers: { 'core-worker': o.scopes ?? ['run', 'read', 'admin'] },
    reload: o.reload ?? (() => caps.reload()),
  });
  const url = await listen(app);
  return {
    url,
    token,
    controller,
    client: new HttpSandbox({ baseUrl: url, token }),
    close: () => app.close(),
  };
}
