import { runService } from '@aisdlc/service-kit';
import { bootGateway } from './boot.js';

await runService('gateway', () => bootGateway(process.env));
