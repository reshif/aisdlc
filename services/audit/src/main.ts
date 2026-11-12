import { runService } from '@aisdlc/service-kit';
import { bootAudit } from './boot.js';

await runService('audit', () => bootAudit(process.env));
