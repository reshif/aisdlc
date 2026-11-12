// The wire form of a proof lives in `@aisdlc/ports` (`step-up-proof.ts`), so verifiers that may not
// import the bff (the kill switch, AR9) read the same bytes. These are its names in the bff.
export {
  stepUpSigningInput as signingInput,
  stepUpDigest as digestOf,
  encodeStepUpToken as encodeToken,
  decodeStepUpToken as decodeToken,
  type DecodedStepUpToken as DecodedToken,
} from '@aisdlc/ports';
