// The coding runner runs INSIDE the W sandbox (src/runner.ts, bundled to dist/runner.js and baked into the
// agent image). Nothing in the factory imports it: the wire between them is `CodingTask` and
// `CodingSessionResult` in @aisdlc/contracts.
export { sessionEnv, harnessFilesIn } from './session.js';
