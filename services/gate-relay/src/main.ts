import { runService } from '@aisdlc/service-kit';
import { bootGateRelay } from './boot.js';

await runService('gate-relay', () => bootGateRelay(process.env));
