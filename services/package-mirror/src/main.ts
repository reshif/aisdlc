import { runService } from '@aisdlc/service-kit';
import { bootMirror } from './boot.js';

await runService('package-mirror', () => bootMirror(process.env));
