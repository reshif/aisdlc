import { runService } from '@aisdlc/service-kit';
import { bootNotifier } from './boot.js';

await runService('notifier', () => bootNotifier(process.env));
