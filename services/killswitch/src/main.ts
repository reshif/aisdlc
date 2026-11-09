import { runService } from '@aisdlc/service-kit';
import { bootKillswitch } from './boot.js';

await runService('killswitch', () => bootKillswitch(process.env));
