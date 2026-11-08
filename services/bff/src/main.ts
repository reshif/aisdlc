import { runService } from '@aisdlc/service-kit';
import { bootBff } from './boot.js';

await runService('bff', () => bootBff(process.env));
