// What an item waits for in words is `waitingSentence` in `work/words.ts` (portal v2).

/** A retry key for one signal: new for every click, the same for a retry of that click. */
export const newKey = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
