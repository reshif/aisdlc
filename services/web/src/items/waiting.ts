// What an item waits for, in words (the `waiting` string of the item view is "kind:detail").

export const waitingText = (waiting: string | null): string => {
  if (waiting === null) return 'It is being worked on by the factory.';
  const [kind, ...rest] = waiting.split(':');
  const detail = rest.join(':');
  switch (kind) {
    case 'human':
      return (
        (
          {
            ready:
              'Waiting for someone to say the request is ready for the first approval (step 1.6).',
            plan: 'Waiting for a person to write the plan (the agent plan was refused twice).',
            schedule: 'Waiting for a person to schedule the work.',
            merge: 'Waiting for a person to merge the change.',
            human_led:
              'A developer has the work (human-led). They say below when it is done, or hand it back.',
          } as Record<string, string>
        )[detail] ?? `Waiting for a person (${detail}).`
      );
    case 'gates':
      return `Waiting for decisions: ${detail.split('+').join(', ')}.`;
    case 'questions':
      return 'Waiting for answers to the questions below.';
    case 'parked':
      return `Parked (${detail}): it ends if nobody answers in time.`;
    case 'blocked':
      return `Blocked (${detail}).`;
    case 'stuck':
      return `Stopped and needs a person to look (${detail}).`;
    case 'handoff':
      return detail === 'e4'
        ? 'Handed to the owner of record: E4 is open on its card (see below).'
        : detail === 'e3'
          ? 'Handed off: an envelope extension is waiting for its decision.'
          : 'Handed off: the owner of record approved E4 and records what happens next (see below).';
    default:
      return `Waiting (${waiting}).`;
  }
};

/** A retry key for one signal: new for every click, the same for a retry of that click. */
export const newKey = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
