import { runService } from '@aisdlc/service-kit';
import { bootDockerProxy } from './boot.js';

await runService('docker-proxy', () => bootDockerProxy(process.env));
