import { codeHostWriteContract } from '@aisdlc/ports/testing';
import { restWriteHarness } from '../src/testing.js';

// The Push Broker contract (the one the in-memory fake passes in @aisdlc/ports) against the GitHub REST adapter in Push
// mode over the in-repo fake GitHub HTTP server: real Git Data API shapes and real git hashing.
codeHostWriteContract(
  'GitHubRestCodeHost (push mode) over the fake GitHub HTTP server',
  restWriteHarness,
);
