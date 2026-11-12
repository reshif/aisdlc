// The gateway's `/v1/messages` call lives in `@aisdlc/ports` (M14.3: the verify service's reviewer makes the same call).
export {
  callMessages,
  type ContentBlock,
  type ModelAnswer,
  type ModelCallFailure,
  type ModelCallOptions,
} from '@aisdlc/ports';
