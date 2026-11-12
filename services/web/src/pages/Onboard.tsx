import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LevelValues, TierValues, type Level, type OnboardRequest } from '@aisdlc/contracts';
import { useId, useState, type FormEvent } from 'react';
import { api, type OnboardInput } from '../api';
import { ErrorNote } from '../components/Notice';
import { useNavigate } from '../router';
import { LEVEL_TEXT } from '../vocab';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]*$/;

/** The project slug a repo name suggests: lower case, anything else becomes a dash. */
export const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');

type Attestations = NonNullable<OnboardRequest['attestations']>;

/**
 * "Onboard a repo": the repo, the level asked for, the project slug, and attestations that can only
 * raise the project's risk (never lower it). Whether the person may do this is the server's call;
 * the button is always there and a refusal is shown as one.
 */
export function OnboardPage({ csrf, mayOnboard }: { csrf: string; mayOnboard: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const ids = { owner: useId(), name: useId(), slug: useId(), tier: useId(), level: useId() };
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [level, setLevel] = useState<Level>('census');
  const [confidential, setConfidential] = useState(false);
  const [deploys, setDeploys] = useState(false);
  const [team, setTeam] = useState(false);
  const [tierFloor, setTierFloor] = useState<'' | NonNullable<Attestations['tier_floor']>>('');
  const [problems, setProblems] = useState<string[]>([]);

  const effectiveSlug = slugTouched ? slug : slugOf(name);

  const m = useMutation({
    mutationFn: (input: OnboardInput) => api.onboard(input, csrf),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['projects'] });
      navigate(`/s0/${r.s0_id}`);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const found: string[] = [];
    if (!OWNER.test(owner.trim())) found.push('Repository owner: letters, digits and dashes.');
    if (!NAME.test(name.trim()))
      found.push('Repository name: letters, digits, dots, dashes, underscores.');
    if (!SLUG.test(effectiveSlug)) {
      found.push(
        'Project slug: lower-case letters, digits, dashes and underscores, starting with a letter or digit.',
      );
    }
    setProblems(found);
    if (found.length > 0) return;
    const attestations: Attestations = {
      ...(confidential ? { classification: 'confidential' as const } : {}),
      ...(deploys ? { deploys: true as const } : {}),
      ...(team ? { mode: 'team' as const } : {}),
      ...(tierFloor !== '' ? { tier_floor: tierFloor } : {}),
    };
    m.mutate({
      project_id: effectiveSlug as OnboardInput['project_id'],
      repo: `${owner.trim()}/${name.trim()}` as OnboardInput['repo'],
      level,
      ...(Object.keys(attestations).length > 0 ? { attestations } : {}),
    });
  }

  return (
    <>
      <h1>Onboard a repo</h1>
      {!mayOnboard ? (
        <p className="notice notice-attention" role="note">
          Your account does not currently hold the right to onboard a repo. You can still try; the
          factory decides.
        </p>
      ) : null}
      <p>
        You do two things to start: ask for the onboarding here, then install the factory GitHub App
        on that one repo. The factory then works mostly on its own and sends you cards to decide.
      </p>
      <form
        onSubmit={submit}
        noValidate
        aria-describedby={problems.length ? 'form-problems' : undefined}
      >
        {problems.length > 0 ? (
          <div className="notice notice-bad" role="alert" id="form-problems">
            <ul className="plain">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <fieldset>
          <legend>Repository</legend>
          <div className="row">
            <div className="field">
              <label htmlFor={ids.owner}>Repository owner</label>
              <input
                id={ids.owner}
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="reshif"
                required
              />
            </div>
            <div className="field">
              <label htmlFor={ids.name}>Repository name</label>
              <input
                id={ids.name}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="asf-factory-testbed"
                required
              />
            </div>
          </div>
        </fieldset>

        <fieldset>
          <legend>Level to ask for</legend>
          {LevelValues.map((l) => (
            <div className="choice" key={l}>
              <input
                type="radio"
                name="level"
                id={`${ids.level}-${l}`}
                value={l}
                checked={level === l}
                onChange={() => setLevel(l)}
                // user decision 2026-11-12: Full is only a level-up of a Light repo, never a first onboarding
                disabled={l === 'full'}
                aria-describedby={`${ids.level}-${l}-d`}
              />
              <label htmlFor={`${ids.level}-${l}`}>{LEVEL_TEXT[l].title}</label>
              <p className="muted" id={`${ids.level}-${l}-d`}>
                {LEVEL_TEXT[l].blurb}
              </p>
              {l === 'full' ? (
                <p className="muted" data-testid="full-only-level-up">
                  Reached only as a level-up after a Light onboarding: card 3 is decided by the
                  intent slot, which exists only after card 4’s role map. Ask for it from the
                  project’s drift page once it is signed at Light.
                </p>
              ) : null}
            </div>
          ))}
        </fieldset>

        <div className="field">
          <label htmlFor={ids.slug}>Project slug</label>
          <input
            id={ids.slug}
            value={effectiveSlug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
            }}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${ids.slug}-d`}
            required
          />
          <p className="muted" id={`${ids.slug}-d`}>
            The project&rsquo;s short name. Used only if this request creates the project.
          </p>
        </div>

        <fieldset>
          <legend>Attestations (optional)</legend>
          <p className="muted">
            These can only raise the project&rsquo;s risk, never lower it. The owner signs the final
            tier on card 1.
          </p>
          <div className="choice">
            <input
              type="checkbox"
              id="att-conf"
              checked={confidential}
              onChange={(e) => setConfidential(e.target.checked)}
            />
            <label htmlFor="att-conf">The repo holds confidential material</label>
          </div>
          <div className="choice">
            <input
              type="checkbox"
              id="att-dep"
              checked={deploys}
              onChange={(e) => setDeploys(e.target.checked)}
            />
            <label htmlFor="att-dep">The project deploys</label>
          </div>
          <div className="choice">
            <input
              type="checkbox"
              id="att-team"
              checked={team}
              onChange={(e) => setTeam(e.target.checked)}
            />
            <label htmlFor="att-team">Team mode (stricter signing rules)</label>
          </div>
          <div className="field">
            <label htmlFor={ids.tier}>Lowest tier to start from</label>
            <select
              id={ids.tier}
              value={tierFloor}
              onChange={(e) => setTierFloor(e.target.value as typeof tierFloor)}
            >
              <option value="">No floor</option>
              {TierValues.filter((t) => t !== 'T0').map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        </fieldset>

        {m.isError ? <ErrorNote error={m.error} /> : null}
        <button type="submit" className="btn" disabled={m.isPending}>
          {m.isPending ? 'Requesting…' : 'Request onboarding'}
        </button>
      </form>
    </>
  );
}
