import { runService } from '@aisdlc/service-kit';
import { bootCodeHost } from './boot.js';

await runService('codehost', () => bootCodeHost(process.env));
