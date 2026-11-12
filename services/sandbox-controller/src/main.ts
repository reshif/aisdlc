import { runService } from '@aisdlc/service-kit';
import { bootSandboxController } from './boot.js';

await runService('sandbox-controller', () => bootSandboxController(process.env));
