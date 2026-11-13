import {
  levelRank,
  type Blocker,
  type LightFloorReport,
  type Level,
  type OnboardingBlockers,
  type OnboardingStatus,
  type ProbeOutcome,
  type SignoffFeasibility,
} from '@aisdlc/contracts';

// explainS0: "why is this onboarding stuck, and whose move is it" (onboarding console P0). A pure function of what the
// caller read from the record, knowledge and the code host: it lists what stands between the onboarding and its
// sign-off as a small graph (a blocker names the blockers it waits behind), each with an owner, a reason code and the
// next action. It decides nothing and changes nothing. Unknown input is reported as a blocker, never as fine.

export interface ExplainInput {
  readonly status: OnboardingStatus;
  readonly requested_level: Level;
  /** The census is recorded (0.1 done) and card 1 can be read. */
  readonly census_ready: boolean;
  /** Census blockers still blocked or unknown (B1, B2, B4a ...). */
  readonly census_blockers_open: readonly string[];
  /** Open secret findings in the repo now (`null`: knowledge could not say). */
  readonly open_secret_findings: number | null;
  /** The newest card of each kind and whether the record waits for it. */
  readonly cards: ReadonlyArray<{
    readonly card: string;
    readonly status: string;
    readonly live: boolean;
    readonly finding_id?: string | null;
  }>;
  /** Controls still blocking card 4 (`null`: not read). */
  readonly controls_blocking_open: readonly string[] | null;
  /** Light only: the floors and the newest probe at this census head (`null`: none yet). */
  readonly floors: LightFloorReport | null;
  readonly probe: { readonly outcome: ProbeOutcome; readonly detail: string | null } | null;
  /** The signing gate's arithmetic for the tier now and the role map proposed (`null`: not computable yet). */
  readonly signoff: SignoffFeasibility | null;
  /** The agent has proposed (or none is configured: false). */
  readonly proposal_ready: boolean;
}

const CARD_TITLE: Record<string, string> = {
  C1: 'Decide the risk tier and what to do about each gap',
  C2: 'Affirm what the agent learned about the repo and its instructions',
  C3: 'Approve the code map and the tests',
  C4: 'Say who decides what, and confirm the GitHub controls',
  C5: 'Sign the readiness scorecard',
  SECR: 'Rule on a secret found in the repo',
};

const PROBE_NODE = 'probe';

/** What a probe that did not pass says to do, and who does it. */
function probeBlocker(
  outcome: ProbeOutcome | null,
  detail: string | null,
  findingsOpen: boolean,
): Blocker | null {
  const base = { kind: 'probe', id: PROBE_NODE } as const;
  switch (outcome) {
    case 'passed':
      return null;
    case null:
      return {
        ...base,
        owner: 'agent',
        code: 'probe_not_run',
        title: 'The tests have not been run yet',
        why: 'Light onboarding needs one clean run of the repo’s setup and tests',
        next: 'The factory runs the probe once the census and the secret check allow it.',
        blocked_by: findingsOpen ? ['secret_findings'] : [],
      };
    case 'b1_blocked':
      return {
        ...base,
        owner: 'security',
        code: 'b1_blocked',
        title: 'The tests cannot run while a secret finding is open',
        why: 'A repo with an open secret finding (or one the factory cannot rule out) never runs its code The result counts as unknown.',
        next: 'Rule on the open secret finding(s); the probe then runs again.',
        blocked_by: ['secret_findings'],
      };
    case 'not_allowed':
      return {
        ...base,
        owner: 'you',
        code: 'exec_not_allowed',
        title: 'This repo is not on the list of repos whose code may run',
        why: 'Running a repo’s own code is allowed only for owners the factory admin listed.',
        next: 'Ask a factory admin to add the repo’s owner to sandbox.exec_allowed_repos, then retry.',
        blocked_by: [],
      };
    case 'no_test_command':
      return {
        ...base,
        owner: 'you',
        code: 'no_test_command',
        title: 'The repo has no test command the factory can find',
        why:
          detail ??
          'The census found no `test` script, Makefile target or justfile recipe, so nothing can run.',
        next: 'Accept the agent’s proposed Makefile with a `test` target (it opens as a pull request you merge), or add one yourself, then re-run the census.',
        blocked_by: [],
      };
    case 'no_image':
      return {
        ...base,
        owner: 'you',
        code: 'no_probe_image',
        title: 'No probe image is approved',
        why: 'config onboarding.sandbox_image names the image the probe runs in; none is approved.',
        next: 'A factory admin approves an image by digest (an M1 settings change).',
        blocked_by: [],
      };
    case 'failed':
      return {
        ...base,
        owner: 'you',
        code: 'probe_failed',
        title: 'The repo’s own tests failed',
        why: detail ?? 'Setup or the tests exited non-zero in a clean checkout.',
        next: 'Fix the failure on GitHub (the log tail is in the evidence), merge it, then re-run the census.',
        blocked_by: [],
      };
    case 'no_tests':
      return {
        ...base,
        owner: 'you',
        code: 'no_tests',
        title: 'The test command ran no tests',
        why: 'It exited 0 but counted zero tests, which proves nothing.',
        next: 'Point the test command at the real suite, then re-run the census.',
        blocked_by: [],
      };
    case 'tests_uncounted':
    case 'void':
    case 'unavailable':
      return {
        ...base,
        owner: 'agent',
        code: outcome,
        title:
          outcome === 'unavailable'
            ? 'The sandbox could not be reached'
            : 'The probe’s result could not be trusted',
        why: detail ?? 'The probe did not leave a result the factory can count (unknown is unmet).',
        next: 'Retry the probe; if it repeats, the runner output needs a person to look at it.',
        blocked_by: [],
      };
  }
}

/** The reading; the caller adds the record's `s0_id`. */
export function explainS0(i: ExplainInput): Omit<OnboardingBlockers, 's0_id'> {
  const out: Blocker[] = [];
  const add = (b: Blocker): void => {
    out.push(b);
  };
  const ids = (): Set<string> => new Set(out.map((b) => b.id));
  const light = levelRank(i.requested_level) >= levelRank('light');
  const closed = ['done', 'rejected', 'withdrawn', 'superseded'].includes(i.status);

  if (!closed) {
    if (!i.census_ready) {
      add({
        id: 'census',
        kind: 'step',
        owner: 'agent',
        code: 'census_pending',
        title: 'The factory is still reading the repo',
        why: 'Nothing can be decided until the census of the repo has been read.',
        next: 'Wait for the census; it needs nothing from you.',
        blocked_by: [],
      });
    }
    if (i.census_ready && !i.proposal_ready) {
      add({
        id: 'agent_proposal',
        kind: 'step',
        owner: 'agent',
        code: 'agent_proposal_pending',
        title: 'The onboarding agent has not proposed yet',
        why: 'The summary you sign needs the agent’s proposal first.',
        next: 'Wait, or ask the agent to run again.',
        blocked_by: [],
      });
    }

    // secret findings: card SECR by the security slot, and the thing that blocks the probe
    const secr = i.cards.filter((c) => c.card === 'SECR' && c.live);
    const open = i.open_secret_findings;
    if ((open ?? 0) > 0 || secr.length > 0 || open === null) {
      add({
        id: 'secret_findings',
        kind: 'finding',
        owner: 'security',
        code: open === null ? 'findings_unknown' : 'secret_finding_open',
        title:
          open === null
            ? 'The factory could not tell whether secrets were found'
            : `${open} secret finding${open === 1 ? '' : 's'} open`,
        why: 'A secret in the repo blocks the tests from running and the readiness scorecard from being signed. Only the security role rules on a finding.',
        next:
          secr.length > 0
            ? 'The security approver decides each secret card; rotate the credential first, then mark the finding.'
            : 'Re-check the repo for secrets; if findings remain a security approver rules on them.',
        blocked_by: [],
      });
    }

    // the controls card 4 needs on GitHub
    for (const c of i.controls_blocking_open ?? []) {
      add({
        id: `control:${c}`,
        kind: 'control',
        owner: 'github',
        code: `control_${c}`,
        title: `GitHub control not in place: ${c.replaceAll('_', ' ')}`,
        why: 'The GitHub controls cannot be confirmed while one that blocks is open. The factory never changes GitHub settings.',
        next: 'Make the change on GitHub (the card says how), then re-check the controls.',
        blocked_by: [],
      });
    }
    for (const b of i.census_blockers_open) {
      if (b === 'B1' || b === 'B2' || b === 'B5') continue; // the secret findings node says it
      add({
        id: `blocker:${b}`,
        kind: 'step',
        owner: 'you',
        code: `census_blocker_${b}`,
        title: `The census found a blocker (${b})`,
        why: 'A census blocker stops the readiness scorecard from being signed.',
        next: 'See the census section of the summary for what clears it.',
        blocked_by: [],
      });
    }

    // Light: the probe and the floors
    if (light && i.census_ready) {
      const p = probeBlocker(
        i.probe?.outcome ?? null,
        i.probe?.detail ?? null,
        ids().has('secret_findings'),
      );
      if (p) add(p);
      for (const f of i.floors?.floors ?? []) {
        if (f.state === 'met' || f.floor === 'LF3') continue;
        // LF1 and LF3 are the findings and the probe above; the rest are card decisions or attestations
        if (f.floor === 'LF1') continue;
        add({
          id: `floor:${f.floor}`,
          kind: 'floor',
          owner: f.floor === 'LF2' ? 'github' : 'you',
          code: f.reasons[0] ?? `${f.floor.toLowerCase()}_${f.state}`,
          title: `A Light requirement is ${f.state === 'unknown' ? 'not known to be met' : 'not met'}: ${f.reasons[0]?.replaceAll('_', ' ') ?? f.floor}`,
          why: `${f.reasons.map((x) => x.replaceAll('_', ' ')).join(', ') || 'no reason given'}. ${f.state === 'unknown' ? 'Unknown counts as unmet.' : 'It must be met to sign Light.'}`,
          next:
            f.floor === 'LF2'
              ? 'Protect the default branch on GitHub and confirm the controls.'
              : f.floor === 'LF4'
                ? 'A factory operator records the worker-image isolation report (npm run evidence:sp-std-1, POST /v1/onboarding/spikes).'
                : 'Affirm the instructions, the claims, the intent and the practices in the summary.',
          blocked_by: f.floor === 'LF2' ? [...ids()].filter((x) => x.startsWith('control:')) : [],
        });
      }
    }

    // the signing arithmetic
    const s = i.signoff;
    if (s !== null && s.state === 'infeasible') {
      add({
        id: 'm4_infeasible',
        kind: 'feasibility',
        owner: 'you',
        code: 'm4_infeasible',
        title: `At this risk the scorecard cannot be signed by the people named`,
        why: `${s.reason ?? 'the signing gate cannot be decided'}. The risk only ever goes up, so naming more people is the way out; lowering it is not possible once raised.`,
        next: `Name more people who may sign the scorecard (“who decides what”, in the role map), or ask a factory admin to grant it; then the scorecard can be signed.`,
        blocked_by: [],
      });
    }

    // the cards that wait for a person
    const have = ids();
    for (const c of i.cards) {
      if (!c.live) continue;
      if (c.card === 'SECR') continue; // the findings node
      const owner: Blocker['owner'] = c.card === 'C5' ? 'signer' : 'you';
      const waits: string[] = [];
      if (c.card === 'C5') {
        for (const k of ['secret_findings', 'm4_infeasible', PROBE_NODE])
          if (have.has(k)) waits.push(k);
        for (const k of have) if (k.startsWith('control:') || k.startsWith('floor:')) waits.push(k);
        // a C5 sits behind the earlier cards too
        for (const o of i.cards)
          if (o.live && ['C1', 'C2', 'C3', 'C4'].includes(o.card)) waits.push(`card:${o.card}`);
      }
      add({
        id: `card:${c.card}`,
        kind: 'card',
        owner,
        code: `card_${c.card.toLowerCase()}_open`,
        title: CARD_TITLE[c.card] ?? `Decide card ${c.card}`,
        why:
          c.card === 'C5'
            ? 'The readiness scorecard is the last decision; it needs the signer’s step-up.'
            : 'The sign-off decides this card from your choices in the summary.',
        next:
          c.card === 'C5'
            ? 'The onboarding signer signs it once nothing above is open.'
            : 'Choose in the summary, then sign off.',
        blocked_by: waits,
      });
    }
  }

  // a blocker may only wait behind blockers that exist
  const all = new Set(out.map((b) => b.id));
  const blockers = out.map((b) => ({
    ...b,
    blocked_by: b.blocked_by.filter((x) => all.has(x) && x !== b.id),
  }));
  // ready: only decisions a person can take now are left (cards), nothing a person must first fix elsewhere
  const ready = !closed && blockers.every((b) => b.kind === 'card');
  return {
    status: i.status,
    requested_level: i.requested_level,
    ready,
    blockers,
    signoff: i.signoff,
  };
}
