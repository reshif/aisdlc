import { runService } from '@aisdlc/service-kit';
import { bootGateCheck } from './boot.js';

await runService('gate-check', () => bootGateCheck(process.env));
