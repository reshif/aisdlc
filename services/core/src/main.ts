import { runService } from '@aisdlc/service-kit';
import { bootCore } from './boot.js';

await runService('core', () => bootCore(process.env));
