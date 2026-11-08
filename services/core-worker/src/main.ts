import { runService } from '@aisdlc/service-kit';
import { bootCoreWorker } from './boot.js';

await runService('core-worker', () => bootCoreWorker(process.env));
