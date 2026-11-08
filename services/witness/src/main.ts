import { runService } from '@aisdlc/service-kit';
import { bootWitness } from './boot.js';

await runService('witness', () => bootWitness(process.env));
