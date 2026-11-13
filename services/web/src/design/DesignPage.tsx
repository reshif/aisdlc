import { label, term } from '@aisdlc/contracts';
import { useState, type ReactNode } from 'react';
import { Link } from '../router';
import { useMayOpenDesign } from '../shell/Shell';
import {
  ActorGlyph,
  Card,
  Chip,
  ConfirmDelete,
  DecisionRail,
  EmptyState,
  ErrorState,
  EvidenceGrid,
  InfoTip,
  KeyValue,
  LockedButton,
  NeedsYouTable,
  PageHeader,
  Pill,
  PropertiesPanel,
  Scorecard,
  SecretField,
  StageStrip,
  Stat,
  Stats,
  Stepper,
  Tabs,
  Term,
  type NeedsYouRow,
} from '../ui';

// /design: every component of the library in both themes, side by side, for review (no Storybook). Open to a
// factory admin, or to anyone on a dev build. The sample text is data, as a screen would show it: the item
// titles and names are made up; every word of the factory's is the glossary's.

type Show = 'both' | 'dark' | 'light';

export function DesignPage() {
  const may = useMayOpenDesign();
  const [show, setShow] = useState<Show>('both');
  if (!may) {
    return (
      <ErrorState
        status={403}
        reason="Only a factory admin can open the design system page."
        action={<Link to="/">Back home</Link>}
      />
    );
  }
  const themes: Array<'dark' | 'light'> = show === 'both' ? ['dark', 'light'] : [show];
  return (
    <>
      <PageHeader
        title={label('screen', 'design')}
        crumbs={[{ label: label('screen', 'home'), to: '/' }, { label: label('screen', 'design') }]}
        meta="Every component of the portal, in the dark and the light theme, with the glossary's words."
        renderLink={(to, l) => <Link to={to}>{l}</Link>}
        actions={
          <div className="ui-gallery-row" role="group" aria-label="Themes shown">
            {(['both', 'dark', 'light'] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={show === s ? 'ui-btn ui-btn-sm ui-btn-primary' : 'ui-btn ui-btn-sm'}
                aria-pressed={show === s}
                onClick={() => setShow(s)}
              >
                {s === 'both' ? 'Both themes' : s === 'dark' ? 'Dark' : 'Light'}
              </button>
            ))}
          </div>
        }
      />
      <div className="ui-design">
        {themes.map((t) => (
          <section
            key={t}
            data-theme={t}
            className="ui-themed"
            aria-label={t === 'dark' ? 'Dark theme' : 'Light theme'}
          >
            <Gallery theme={t} />
          </section>
        ))}
      </div>
    </>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

const SWATCHES = [
  '--bg',
  '--panel',
  '--panel-2',
  '--panel-3',
  '--line-2',
  '--fg',
  '--muted',
  '--faint',
  '--accent',
  '--accent-text',
  '--link',
  '--ok',
  '--warn',
  '--bad',
  '--agent',
  '--human',
];

const NEEDS: readonly NeedsYouRow[] = [
  {
    id: 'a',
    kind: { kind: 'gate', gate: 'G4' },
    what: 'Add farewell() greeting',
    project: 'payments-api',
    item: 'PAY-42',
    due: { text: 'Due in 2 h', at: '2026-11-13T12:00:00Z' },
    to: '/design',
  },
  {
    id: 'b',
    kind: { kind: 'gate', gate: 'G2' },
    what: 'Export invoices as CSV',
    project: 'web-portal',
    item: 'WEB-7',
    due: { text: 'Overdue by 1 working day', overdue: true, at: '2026-11-12T09:00:00Z' },
    to: '/design',
  },
  {
    id: 'c',
    kind: { kind: 'questions' },
    what: 'Currency rounding: round 1 of 2',
    project: 'ledger-svc',
    item: 'LED-9',
    due: { text: 'Pauses in 3 working days', at: '2026-11-16T09:00:00Z' },
    to: '/design',
  },
  {
    id: 'd',
    kind: { kind: 'onboarding' },
    what: 'web-portal',
    project: 'web-portal',
    due: { text: 'Due in 3 working days', at: '2026-11-17T09:00:00Z' },
    to: '/design',
  },
];

function Gallery({ theme }: { theme: 'dark' | 'light' }) {
  const [tab, setTab] = useState('now');
  const [pick, setPick] = useState<string | null>('checks');
  const [del, setDel] = useState(false);
  const [decided, setDecided] = useState<string | null>(null);
  const [secretAt, setSecretAt] = useState<string | null>(null);
  const link = (to: string, children: ReactNode, className?: string) => (
    <Link to={to} {...(className ? { className } : {})}>
      {children}
    </Link>
  );
  return (
    <div className="ui-gallery">
      <Block title="Colour tokens">
        <div className="ui-swatches">
          {SWATCHES.map((s) => (
            <div key={s} className="ui-swatch">
              <i style={{ background: `var(${s})` }} />
              <span>{s}</span>
            </div>
          ))}
        </div>
      </Block>

      <Block title="Type">
        <p style={{ fontFamily: 'var(--display)', fontSize: 32, fontWeight: 600, margin: 0 }}>
          A governed software factory
        </p>
        <p style={{ margin: '4px 0' }}>
          Body text in IBM Plex Sans. Agents plan, build and verify; people decide every approval.
        </p>
        <p className="ui-mono" style={{ margin: 0 }}>
          Commit 3f2a91c · IBM Plex Mono for codes and commits
        </p>
      </Block>

      <Block title="Buttons">
        <div className="ui-gallery-row">
          <button type="button" className="ui-btn ui-btn-primary">
            {label('decision', 'approve')}
          </button>
          <button type="button" className="ui-btn">
            {label('decision', 'request_changes')}
          </button>
          <button type="button" className="ui-btn ui-btn-danger">
            {label('decision', 'reject')}
          </button>
          <button type="button" className="ui-btn ui-btn-ghost">
            {label('decideWord', 'unsure')}
          </button>
          <button type="button" className="ui-btn ui-btn-sm">
            {label('decideWord', 'hand_back')}
          </button>
          <button type="button" className="ui-btn" disabled>
            {label('decideWord', 'ask_for_work')}
          </button>
          <LockedButton
            label={label('gate', 'G3')}
            reason="Only the design and plan approver can approve this. Ask Rana Begum."
            request={<Link to="/me/access">Request access</Link>}
          />
        </div>
      </Block>

      <Block title="Pills, terms and codes">
        <div className="ui-gallery-row">
          <Pill tone="ok">{label('verdict', 'passed')}</Pill>
          <Pill tone="bad">{label('verdict', 'failed')}</Pill>
          <Pill tone="warn">{label('verdict', 'unknown')}</Pill>
          <Pill tone="info">{label('phase', 'G4')}</Pill>
          <Pill tone="agent">{label('agent', 'coder')}</Pill>
          <Pill tone="human">{label('phase', 'Handoff')}</Pill>
          <Pill tone="gate">{label('gateStatus', 'pending')}</Pill>
          <Pill tone="back">{label('backEdge', 'B13')}</Pill>
          <Pill tone="mute">{label('phase', 'Deferred')}</Pill>
        </div>
        <div className="ui-gallery-row" style={{ marginTop: 10 }}>
          <Term family="gate" value="G3" showCode />
          <Term family="lane" value="L3" showCode />
          <Term family="level" value="census" />
          <Term family="stage" value="S4" showCode audience="audit" />
          <InfoTip about={label('concept', 'prr')} text={term('concept', 'prr').explain} />
          <Chip itemKey="PAY-42" lane="L3" />
          <ActorGlyph actor="D+A" />
        </div>
      </Block>

      <Block title="Page header">
        <PageHeader
          title="Add farewell() greeting"
          crumbs={[
            { label: 'payments-api', to: '/design' },
            { label: label('screen', 'items'), to: '/design' },
            { label: 'PAY-42' },
          ]}
          meta={`${label('lane', 'L3')} · requested by Daniel Novak · ${label('concept', 'catalogue')} 1.4.0`}
          status={<Pill tone="info">{label('phase', 'G4')}</Pill>}
          actions={
            <button type="button" className="ui-btn ui-btn-sm">
              Open PR on GitHub
            </button>
          }
          renderLink={(to, l) => <Link to={to}>{l}</Link>}
        />
      </Block>

      <Block title="Needs you">
        <NeedsYouTable rows={NEEDS} renderLink={link} />
        <div style={{ marginTop: 10 }}>
          <NeedsYouTable
            rows={[]}
            renderLink={link}
            empty="Nothing needs you. Ask for work to start, or onboard a repo."
          />
        </div>
      </Block>

      <Block title="Stage strip">
        <StageStrip current="S8" waitingOn="Waiting for Alex Rivera" />
        <StageStrip
          current="S3"
          marks={{ S2: 'skipped', S4: 'skipped' }}
          waitingOn={label('gate', 'G2')}
        />
      </Block>

      <Block title="Tabs">
        <Tabs
          label="Item tabs"
          tabs={[
            { id: 'now', label: 'Now' },
            { id: 'request', label: 'Request' },
            { id: 'documents', label: 'Documents' },
            { id: 'verify', label: label('stage', 'S7') },
            { id: 'timeline', label: 'Timeline' },
          ]}
          selected={tab}
          onSelect={setTab}
        >
          <p style={{ margin: 0 }}>The {tab} tab.</p>
        </Tabs>
      </Block>

      <Block title="Evidence and the decision rail">
        <div className="ui-decide" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
          <EvidenceGrid
            selected={pick}
            onOpen={setPick}
            tiles={[
              {
                id: 'checks',
                title: label('step', '7.1'),
                verdict: 'passed',
                detail: '5 of 5 passed',
              },
              { id: 'integrity', title: label('step', '7.2'), verdict: 'passed' },
              {
                id: 'spec',
                title: label('step', '7.3'),
                verdict: 'unknown',
                detail: 'Treated as not passed',
              },
              {
                id: 'secrets',
                title: label('step', '7.4'),
                verdict: 'failed',
                detail: '1 new dependency',
              },
              {
                id: 'pack',
                title: label('concept', 'evidence_pack'),
                detail: 'Signed for commit 3f2a91c',
              },
              { id: 'check', title: label('concept', 'gate_check'), detail: 'Waiting on GitHub' },
            ]}
          />
          <DecisionRail
            inline
            who={
              <>
                Alex Rivera decides, as {label('role', 'project.code_owner').toLowerCase()}. You may
                decide.
              </>
            }
            access={{ state: 'allow' }}
            twoPerson={{ have: 1, need: 2, by: ['Ana Ruiz'] }}
            sendBack="1 of 2 tries left"
            rejectTo="back to the plan"
            unsure={() => setDecided('A code owner will do a full review.')}
            {...(decided ? { result: decided } : {})}
            onDecide={(v, r) =>
              setDecided(`${label('decision', v)} recorded${r ? `: ${r}` : ''} (decision log #59).`)
            }
          />
          <DecisionRail
            inline
            who="Rana Begum decides, as design and plan approver."
            access={{
              state: 'deny',
              reason: 'Only the design and plan approver can approve this. Ask Rana Begum.',
              request: <Link to="/me/access">Request access</Link>,
            }}
            onDecide={() => undefined}
          />
        </div>
      </Block>

      <Block title="Properties panel">
        <PropertiesPanel
          rows={[
            { label: label('concept', 'lane'), value: label('lane', 'L3') },
            { label: label('role', 'project.requester'), value: 'Daniel Novak' },
            { label: label('concept', 'unit'), value: `1 · ${label('unitState', 'Pushed')}` },
            { label: label('concept', 'envelope'), value: '$3.10 of $5.00' },
            { label: 'Rework limit', value: '0 of 3 used' },
            { label: label('concept', 'catalogue'), value: '1.4.0' },
          ]}
          actions={
            <>
              <button type="button" className="ui-btn ui-btn-sm">
                {label('decideWord', 'hand_back')}
              </button>
              <button type="button" className="ui-btn ui-btn-sm">
                {label('decision', 'withdraw')}
              </button>
            </>
          }
        />
      </Block>

      <Block title="Scorecard">
        <Scorecard
          title={label('concept', 'prr')}
          summary={`${label('level', 'light')}: agents may make small changes. Next: ${label('level', 'full')} needs repo facts at 90%.`}
          items={[
            { id: 'LF1', label: label('lightFloor', 'LF1'), state: 'met' },
            { id: 'LF2', label: label('lightFloor', 'LF2'), state: 'met' },
            { id: 'LF3', label: label('lightFloor', 'LF3'), state: 'met' },
            { id: 'LF4', label: label('lightFloor', 'LF4'), state: 'unknown' },
            { id: 'LF5', label: label('lightFloor', 'LF5'), state: 'met' },
            {
              id: 'LF6',
              label: label('lightFloor', 'LF6'),
              state: 'not_met',
              detail: '84% confirmed, 90% needed',
            },
            { id: 'LF7', label: label('lightFloor', 'LF7'), state: 'recorded' },
            { id: 'LF8', label: label('lightFloor', 'LF8'), state: 'na' },
          ]}
          footer={
            <button type="button" className="ui-btn ui-btn-sm">
              {label('concept', 'level')}: raise the level
            </button>
          }
        />
      </Block>

      <Block title="Stepper">
        <Stepper
          label="Settings change steps"
          steps={[
            { id: 'change', label: 'Change', state: 'done' },
            { id: 'preview', label: 'Preview', state: 'current', detail: '3 items affected' },
            { id: 'approve', label: label('gate', 'M1'), state: 'todo' },
          ]}
        />
        <Stepper
          label="Onboarding steps"
          steps={[
            { id: '0.1', label: label('step', '0.1'), state: 'done' },
            { id: '0.2', label: label('step', '0.2'), state: 'done' },
            {
              id: '0.4',
              label: label('step', '0.4'),
              state: 'blocked',
              detail: label('blocker', 'B3'),
            },
            { id: '0.5', label: label('step', '0.5'), state: 'todo' },
          ]}
        />
      </Block>

      <Block title="Secret field and delete">
        <SecretField
          label="GitHub App private key"
          isSet={secretAt !== null || theme === 'dark'}
          lastChanged={secretAt ?? '2 h ago'}
          onSave={() => setSecretAt('just now')}
        />
        <div style={{ marginTop: 12 }}>
          <SecretField label="Slack webhook" isSet={false} onSave={() => undefined} />
        </div>
        <div style={{ marginTop: 12 }}>
          <button type="button" className="ui-btn ui-btn-danger" onClick={() => setDel(true)}>
            {label('concept', 'delete')} project payments-api
          </button>
          <ConfirmDelete
            open={del}
            kind="project"
            name="payments-api"
            consequences="Its repos, work items, documents, settings, history and evidence packs. The decision log keeps only each entry's hash."
            onConfirm={() => setDel(false)}
            onClose={() => setDel(false)}
          />
        </div>
      </Block>

      <Block title="Cards, stats and facts">
        <Stats label="Work now">
          <Stat label={label('screen', 'inbox')} value="4" detail="1 overdue" tone="warn" />
          <Stat label={label('phase', 'S6')} value="2" />
          <Stat label={label('phase', 'Handoff')} value="1" tone="bad" />
        </Stats>
        <Card title="About">
          <KeyValue
            rows={[
              [label('concept', 'repo'), 'acme/payments-api'],
              [label('configKey', 'project.release'), 'Off (merged is done)'],
              [label('configKey', 'sandbox.exec_allowed_repos'), 'Yes'],
            ]}
          />
        </Card>
      </Block>

      <Block title="Empty and error states">
        <EmptyState
          title="No work yet."
          action={
            <button type="button" className="ui-btn ui-btn-primary">
              {label('decideWord', 'ask_for_work')}
            </button>
          }
        >
          Work you ask for shows here with its stage.
        </EmptyState>
        <div style={{ marginTop: 12 }}>
          <ErrorState
            status={403}
            reason="Only a project admin can change project settings."
            ask="Ask Rana Begum or a factory admin."
          />
        </div>
        <div style={{ marginTop: 12 }}>
          <ErrorState status={404} />
        </div>
      </Block>
    </div>
  );
}
