import type { Tone } from '../vocab';

/** The state as words, never as colour alone. */
export function Badge({ tone, children }: { tone: Tone; children: string }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
