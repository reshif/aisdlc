import { runService } from '@aisdlc/service-kit';
import { bootVerify } from './boot.js';

await runService('verify', () => bootVerify(process.env));
