import { Pill, type PillTone } from '../ui';
import type { Tone } from '../vocab';

const PILL: Readonly<Record<Tone, PillTone>> = {
  neutral: 'neutral',
  active: 'info',
  attention: 'warn',
  bad: 'bad',
  good: 'ok',
};

/** The state as words, never as colour alone (a library Pill; `badge` stays for the e2e selectors). */
export function Badge({ tone, children }: { tone: Tone; children: string }) {
  return (
    <Pill tone={PILL[tone]} className={`badge badge-${tone}`}>
      {children}
    </Pill>
  );
}
