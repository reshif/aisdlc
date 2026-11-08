import { runService } from '@aisdlc/service-kit';
import { bootKms } from './boot.js';

await runService('kms-local', () => bootKms(process.env));
