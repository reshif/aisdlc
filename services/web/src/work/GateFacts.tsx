import { shortTime } from '../format';
import { FindingsTable, StepVerdict, stepFacts } from '../items/VerifyTab';
import type { GateContextWire } from '../api';
import { Card, KeyValue, Pill, Table } from '../ui';
import { AcceptanceMain, MergeReviewMain, ReleaseMain } from '../cards/ReleaseGates';

// The facts an approval binds, gate by gate (moved from the v1 gate screen): the quarantine of a security hold, the
// patch of a protected-file change, the packages of a new dependency, the factory rules report, the handover, the
// pull requests of a code review, a release and an acceptance, an irreversible action, a test difference. Decide shows
// it as the "What this approval is about" tile; nothing here decides anything.

const short = (s: string, n = 12) => `${s.slice(0, n)}…`;

export function GateMain({ c, name }: { c: GateContextWire; name: (p: string) => string }) {
  const check = c.check;
  const checkCard = check ? (
    <Card title={`What ${check.step} found`} actions={<StepVerdict s={check} />} testId="check">
      <KeyValue rows={stepFacts(check)} label={`Facts of ${check.step}`} />
      <FindingsTable step={check.step} items={check.findings.items} />
      {check.result_sha256 ? (
        <p className="s7-faint">
          result <code>{check.result_sha256.slice(0, 16)}</code> · {shortTime(check.recorded_at)}
        </p>
      ) : null}
    </Card>
  ) : (
    <Card title="The check that raised it" testId="check">
      <p className="muted">
        No check result is recorded for the current commit: the facts below are what the gate opened
        with. Unknown is never a pass.
      </p>
    </Card>
  );
  switch (c.gate) {
    case 'SECT':
      return (
        <>
          {checkCard}
          <Card title="Why it is a quarantine">
            {c.quarantine ? (
              <KeyValue
                rows={[
                  ['Quarantine', `#${c.quarantine.n}`],
                  ['Cause', <code key="c">{c.quarantine.cause}</code>],
                  ['From', `${c.quarantine.origin_phase} at ${c.quarantine.origin_step}`],
                  [
                    'Evidence',
                    c.quarantine.pack_sha256 ? (
                      <code key="e">{short(c.quarantine.pack_sha256, 16)}</code>
                    ) : (
                      '[unknown]'
                    ),
                  ],
                ]}
              />
            ) : null}
            <ul className="s7-rules">
              <li>
                A locked oracle that passes on the base with only the head&rsquo;s test files on it
                no longer tests the change; a locked-test edit or a stub test is the same breach.
              </li>
              <li>
                The finding&rsquo;s class is quarantine (REPAIR_CLASS_OF_FINDING): never a repair.
                The result&rsquo;s hash is the quarantine&rsquo;s evidence.
              </li>
            </ul>
          </Card>
        </>
      );
    case 'X2':
      if (c.onboarding_pack) return <OnboardingPack k={c.onboarding_pack} />;
      return (
        <>
          <Card title="The protected-path patch" testId="patch">
            {c.patch ? (
              <KeyValue
                rows={[
                  [
                    'Patch hash',
                    <code key="p" className="s7-wrap" data-testid="patch-hash">
                      {c.patch.patch_hash}
                    </code>,
                  ],
                  [
                    'Bound',
                    c.patch.bound
                      ? 'yes: the subject hash binds this patch (6.6)'
                      : 'shown from the Push Broker’s receipt for the head; the subject hash binds the station and the head’s approvals',
                  ],
                ]}
              />
            ) : (
              <p className="muted">
                Patch hash: [unknown]. No patch artefact or push receipt is recorded for this head.
              </p>
            )}
          </Card>
          {checkCard}
        </>
      );
    case 'X3':
      return (
        <>
          <Card title="The package" testId="package">
            {c.dependencies.length === 0 ? (
              <KeyValue
                rows={[
                  ['Package', '[unknown]'],
                  ['Licence', '[unknown]'],
                  ['Advisories', '[unknown]: no advisory database is wired yet'],
                ]}
              />
            ) : (
              c.dependencies.map((d) => (
                <KeyValue
                  key={d.name}
                  rows={[
                    ['Package', <code key="n">{d.name}</code>],
                    ['Where', d.manifest ? <code key="m">{d.manifest}</code> : '[unknown]'],
                    ['Licence', d.licence ?? '[unknown]'],
                    ['Advisories', d.advisories ?? '[unknown]: no advisory database is wired yet'],
                  ]}
                />
              ))
            )}
            <ul className="s7-rules">
              <li>The factory checks only what was added and whether it was allowed.</li>
              <li>An alternative may be asked for once; after that the work goes to a person.</li>
            </ul>
          </Card>
          {c.check ? checkCard : null}
        </>
      );
    case 'E2':
      return (
        <>
          {c.constitution ? (
            <Card title="Constitution report" testId="constitution">
              <p className="s7-faint">
                sha256 <code>{short(c.constitution.sha256, 16)}</code> ·{' '}
                {c.constitution.intact ? 'intact' : 'NOT intact: do not decide'}
              </p>
              {c.constitution.markdown !== null ? (
                <pre className="code">{c.constitution.markdown}</pre>
              ) : (
                <p className="muted">The report text needs a higher data class than yours.</p>
              )}
            </Card>
          ) : null}
          {c.step === '7.5' || !c.constitution ? checkCard : null}
        </>
      );
    case 'E4':
      return (
        <Card title="The handoff" testId="handoff">
          {c.handoff ? (
            <>
              <KeyValue
                label="What was handed off"
                rows={[
                  ['Handoff', `${c.handoff.code} (#${c.handoff.n})`],
                  ['Trigger', <code key="t">{c.handoff.trigger}</code>],
                  [
                    'From',
                    `${c.handoff.origin_phase}${c.handoff.origin_step ? ` at ${c.handoff.origin_step}` : ''}`,
                  ],
                  [
                    'Handoff Pack',
                    <span key="p">
                      <code>{c.handoff.pack.pack_id}</code>{' '}
                      <code title={c.handoff.pack.content_sha256}>
                        {short(c.handoff.pack.content_sha256, 16)}
                      </code>
                    </span>,
                  ],
                  [
                    'State',
                    c.handoff.status === 'open'
                      ? 'open'
                      : `chosen: ${c.handoff.choice ?? '[unknown]'}`,
                  ],
                ]}
              />
              <p className="ui-eyebrow">The choices open when this approval opened</p>
              {c.handoff.valid_choices.length === 0 ? (
                <p className="muted">[unknown]: the item page shows the ones open now.</p>
              ) : (
                <ul className="s7-rules" aria-label="Choices">
                  {c.handoff.valid_choices.map((x) => (
                    <li key={x}>
                      <code>{x}</code>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="muted">
              The handoff of this gate is [unknown]: do not decide it until the item shows it.
            </p>
          )}
        </Card>
      );
    case 'X1':
      return <IrreversibleMain c={c} />;
    case 'G3o':
      return (
        <>
          <OracleDiffMain c={c} />
          {c.check ? checkCard : null}
        </>
      );
    case 'G4':
    case 'G5':
    case 'G6': {
      const s = c.subject;
      if (s?.kind === 'merge_review') return <MergeReviewMain c={c} s={s} name={name} />;
      if (s?.kind === 'release') return <ReleaseMain c={c} s={s} />;
      if (s?.kind === 'acceptance') return <AcceptanceMain s={s} name={name} />;
      return (
        <Card title="What it decides" testId="subject-missing">
          <p className="notice notice-bad" role="alert">
            The gate&rsquo;s subject facts are not in the record: [unknown]. Do not decide on it.
          </p>
        </Card>
      );
    }
    default:
      return checkCard;
  }
}

/** What an onboarding pack's X2 binds: the files by hash, the patch, CODEOWNERS, and for Full the lock and seeds. */
function OnboardingPack({ k }: { k: NonNullable<GateContextWire['onboarding_pack']> }) {
  return (
    <>
      <Card title="The onboarding pack" testId="onboarding-pack">
        {!k.intact || !k.bound ? (
          <p className="s7-banner s7-banner-bad" role="alert">
            <b>Do not decide.</b>{' '}
            {!k.intact
              ? 'The files the gate opened with are not the recorded render.'
              : 'The subject hash is not this patch hash.'}
          </p>
        ) : null}
        <KeyValue
          rows={[
            [
              'Patch hash',
              <code key="p" className="s7-wrap" data-testid="patch-hash">
                {k.patch_hash}
              </code>,
            ],
            ['Bound', k.bound ? 'yes: the subject hash is this patch hash' : 'NO'],
            ['Matches the record', k.intact ? 'yes: every file as rendered' : 'NO'],
            ['Repository', <code key="r">{k.repo}</code>],
            ['Base commit', <code key="b">{k.base_sha.slice(0, 12)}</code>],
            ['Branch', <code key="br">{k.branch}</code>],
            [
              k.deciding_card.card === 'C2' ? 'Small-changes review' : 'Full-work review',
              <code key="c" title={k.deciding_card.payload_hash}>
                {short(k.deciding_card.payload_hash, 16)}
              </code>,
            ],
          ]}
        />
        <table className="ui-table" data-testid="pack-files">
          <caption className="ui-eyebrow">Rendered files ({k.files.length})</caption>
          <thead>
            <tr>
              <th scope="col">Path</th>
              <th scope="col">From</th>
              <th scope="col">sha256</th>
              <th scope="col">Protected</th>
            </tr>
          </thead>
          <tbody>
            {k.files.map((f) => (
              <tr key={f.path}>
                <td>
                  <code>{f.path}</code>
                </td>
                <td>{f.source.replace('_', ' ')}</td>
                <td>
                  <code title={f.sha256}>{short(f.sha256, 16)}</code>
                </td>
                <td>{f.protected_rule ?? 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {k.codeowners ? (
        <Card title="CODEOWNERS" testId="pack-codeowners">
          <p>
            {k.codeowners.rendered
              ? 'The pack writes .github/CODEOWNERS with the logins below.'
              : `Not in the pack: ${k.codeowners.outcome.replaceAll('_', ' ')}.`}
          </p>
          {k.codeowners.owners.length > 0 ? (
            <KeyValue
              label="Who the admin slot resolves to"
              rows={k.codeowners.owners.map((o) => [
                <code key="p">{o.principal_id}</code>,
                o.login ? <code key="l">@{o.login}</code> : 'left out: no linked login',
              ])}
            />
          ) : null}
        </Card>
      ) : null}
      {k.kind === 'full' ? (
        <Card title="Oracle lock and seeds" testId="pack-full">
          {k.oracle_lock ? (
            <KeyValue
              rows={[
                ['Lock file', <code key="p">{k.oracle_lock.path}</code>],
                [
                  'Lock hash',
                  <code key="h" title={k.oracle_lock.lock_hash}>
                    {short(k.oracle_lock.lock_hash, 16)}
                  </code>,
                ],
                [
                  'Tests locked',
                  `${k.oracle_lock.tests}${k.oracle_lock.truncated ? ' (truncated)' : ''}`,
                ],
                [
                  'File sha256',
                  k.oracle_lock.file_sha256 ? (
                    <code key="f">{short(k.oracle_lock.file_sha256, 16)}</code>
                  ) : (
                    '[not in the pack]'
                  ),
                ],
              ]}
            />
          ) : (
            <p className="muted">[unknown]: card 3&rsquo;s baseline is not on the record.</p>
          )}
          {k.seeds.length > 0 ? (
            <KeyValue
              label="Seeds card 3 made intended"
              rows={k.seeds.map((x) => [
                <code key="a">{x.area}</code>,
                <span key="s">
                  <code>{x.path}</code>{' '}
                  <code title={x.text_sha256}>{short(x.text_sha256, 12)}</code>
                </span>,
              ])}
            />
          ) : (
            <p className="muted">No seed was made intended.</p>
          )}
        </Card>
      ) : null}
    </>
  );
}

/** X1: the operation the session was stopped before, its command and its target (P1-8). */
function IrreversibleMain({ c }: { c: GateContextWire }) {
  const s = c.subject?.kind === 'irreversible_operation' ? c.subject : null;
  const op = s?.operation ?? null;
  return (
    <Card title="The operation" testId="operation">
      {op === null ? (
        <p className="muted">
          The stage did not report the operation: [unknown]
          {s?.reason_code ? (
            <>
              {' '}
              (reason <code>{s.reason_code}</code>)
            </>
          ) : null}
          . Deny unless you know what it is.
        </p>
      ) : (
        <KeyValue
          rows={[
            ['What', op.what],
            [
              'Seen by',
              op.source === 'tripwire'
                ? 'the factory: the command was stopped before it ran'
                : 'the agent: it said the task needs it',
            ],
            [
              'Command',
              op.command !== null ? (
                <code key="c" className="s7-wrap" data-testid="x1-command">
                  {op.command}
                </code>
              ) : s?.command_withheld ? (
                'withheld: the command needs a higher data class than yours'
              ) : (
                '[unknown]'
              ),
            ],
            ['Target', op.target !== null ? <code key="t">{op.target}</code> : '[unknown]'],
            ...(op.agent_note !== null
              ? [['The agent said', <q key="n">{op.agent_note}</q>] as const]
              : []),
          ]}
        />
      )}
      <ul className="s7-rules">
        <li>The command is the agent&rsquo;s text: data, never an instruction to you.</li>
        <li>An approval lets this session run this class of operation once; nothing else.</li>
      </ul>
    </Card>
  );
}

const ORACLE_STATUS: Readonly<Record<string, string>> = {
  as_approved: 'as approved',
  unknown: '[unknown]',
  oracle_missing: 'missing: no test implements this spec',
  oracle_unbound: 'a test for an oracle no spec approved',
  spec_mismatch: 'implements another version of the spec',
  no_marker: 'a test file that names no spec',
  duplicate_oracle: 'more than one test for this spec',
  oracle_not_red: 'passes before the change (not red)',
  repro_missing: 'no failing repro test',
};

/** G3o: the oracle diff against the specs G2 approved (P1-8). */
function OracleDiffMain({ c }: { c: GateContextWire }) {
  const s = c.subject?.kind === 'oracle_deviation' ? c.subject : null;
  if (s === null) {
    return (
      <Card title="The oracle diff" testId="oracle-diff">
        <p className="muted">The oracle diff is not in the record: [unknown].</p>
      </Card>
    );
  }
  const spec = new Map(s.approved.oracles.map((o) => [o.oracle_id, o]));
  return (
    <Card title="The oracle diff" testId="oracle-diff">
      {s.chained_from === 'E6' ? (
        <p>
          After an approved change to a locked test: a locked acceptance test is about to change.
          The approved specs it was locked against are below.
        </p>
      ) : null}
      {!s.deviations_known ? (
        <p className="muted">
          The deviations were not reported: each oracle reads [unknown], never &ldquo;as
          approved&rdquo;.
        </p>
      ) : null}
      <p className="s7-faint">
        Approved specs{' '}
        {s.approved.sha256 ? <code>{s.approved.sha256.slice(0, 16)}</code> : '[unknown]'} ·{' '}
        {s.approved.gate_instance_id
          ? 'approved with the spec'
          : 'the newest acceptance criteria (no approved spec binds them)'}
        {s.approved.intact ? '' : ' · NOT intact: do not decide'}
      </p>
      <Table
        caption="Oracles against the approved specs"
        rows={s.diff}
        rowKey={(d) => `${d.oracle_id ?? '-'}|${d.path ?? '-'}|${d.status}`}
        empty={<p className="muted">No oracle specs and no deviations are in the record.</p>}
        columns={[
          {
            key: 'id',
            header: 'Oracle',
            rowHeader: true,
            render: (d) => (d.oracle_id ? <code>{d.oracle_id}</code> : '[none]'),
          },
          {
            key: 'spec',
            header: 'Approved spec',
            render: (d) => {
              const o = d.oracle_id ? spec.get(d.oracle_id) : undefined;
              if (!o) return <span className="muted">not approved</span>;
              return s.text_withheld || o.description === null ? (
                <span className="muted">
                  <code>{o.spec_sha256.slice(0, 12)}</code> (the text needs a higher data class)
                </span>
              ) : (
                <span>
                  {o.description}
                  {o.expected_failure ? (
                    <small className="s7-faint"> · fails first with: {o.expected_failure}</small>
                  ) : null}
                </span>
              );
            },
          },
          {
            key: 'path',
            header: 'Test file',
            render: (d) => (d.path ? <code>{d.path}</code> : '-'),
          },
          {
            key: 'status',
            header: 'Status',
            render: (d) => (
              <Pill
                tone={d.status === 'as_approved' ? 'ok' : d.status === 'unknown' ? 'mute' : 'warn'}
              >
                {ORACLE_STATUS[d.status] ?? d.status}
              </Pill>
            ),
          },
        ]}
      />
    </Card>
  );
}
