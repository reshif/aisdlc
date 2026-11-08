import { runService } from '@aisdlc/service-kit';
import { bootKnowledge } from './boot.js';

await runService('knowledge', () => bootKnowledge(process.env));
