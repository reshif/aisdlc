import { runService } from '@aisdlc/service-kit';
import { bootNotary } from './boot.js';

await runService('notary', () => bootNotary(process.env));
