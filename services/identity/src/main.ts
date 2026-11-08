import { runService } from '@aisdlc/service-kit';
import { bootIdentity } from './boot.js';

await runService('identity', () => bootIdentity(process.env));
