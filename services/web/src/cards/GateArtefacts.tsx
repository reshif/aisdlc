import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { Callout, ErrorNote, Loading } from '../components/Notice';
import { Link } from '../router';
import { GateDecide } from './GateDecide';

const TITLE: Readonly<Record<string, string>> = {
  G0: 'Lane and intent',
  G1: 'Intent acceptance',
  G1f: 'Intent acceptance, final',
  E1: 'Exception: the work is smaller than its lane',
  G2: 'Spec and oracle-spec approval',
  G3d: 'Design and threat sign-off',
  E2: 'Exception: the design breaks the constitution',
  G3: 'Plan approval',
  G3s: 'Plan skeleton',
};

const TYPE_LABEL: Readonly<Record<string, string>> = {
  context_brief: 'Context brief',
  reverse_engineering: 'Reverse engineering',
  impact: 'Impact and stakeholders',
  decision_brief: 'Decision brief',
  initiative: 'Initiative',
  spec_delta: 'Spec delta',
  oracle_specs: 'Oracle specs',
  spec_review: 'Clean-context review',
  classification: 'Classification',
  intent_block: 'Intent',
  adr: 'Decisions (ADRs)',
  contracts: 'Contracts',
  data_migration: 'Data and migration',
  nfr_threat_ops: 'NFR, threats and operations',
  constitution_report: 'Constitution check',
  unit_split: 'Units',
  unit_sequence: 'Sequence',
  plan: 'Task plan',
  verification_binding: 'Verification binding',
  budget_envelope: 'Budget envelope',
  capacity_input: 'Capacity input',
};

/**
 * A work-item gate card that decides artefacts (G0 and G1, G1f, G2, G3d, G3, E1, E2): each artefact the gate's subject hash binds,
 * rendered, with its hash. The text is the agent's own words, so it is shown as text in a block (React
 * escapes it; nothing is parsed as markup or HTML), and an artefact whose stored bytes do not hash to the
 * bound hash is shown as not intact instead of its text.
 */
export function GateArtefacts({ id, csrf }: { id: string; csrf: string }) {
  const q = useQuery({
    queryKey: ['card-artefacts', id],
    queryFn: () => api.cardArtefacts(id),
    refetchOnWindowFocus: false,
  });
  if (q.isPending) return <Loading what="the artefacts" />;
  if (q.isError) return <ErrorNote error={q.error} retry={() => void q.refetch()} />;
  const v = q.data;
  return (
    <>
      <p className="crumbs">
        <Link to="/inbox">Inbox</Link>
      </p>
      <h1>{v.gates.map((g) => TITLE[g] ?? g).join(' and ')}</h1>
      <p className="status-line">
        Decides <strong>{v.artefacts.length}</strong> artefacts together; subject{' '}
        <code title="the hash the decision is bound to">{v.subject_hash.slice(0, 16)}</code>
      </p>
      {v.intact ? null : (
        <Callout title="An artefact is not intact">
          <p>
            At least one artefact is missing or does not hash to the hash this gate binds. Do not
            decide this card.
          </p>
        </Callout>
      )}
      {v.artefacts.map((a) => (
        <section key={`${a.step}:${a.sha256}`} className="prr" aria-label={a.type}>
          <h2>
            {TYPE_LABEL[a.type] ?? a.type}{' '}
            <Badge tone={a.intact ? 'good' : 'bad'}>{a.intact ? 'intact' : 'not intact'}</Badge>
          </h2>
          <p className="muted">
            Step {a.step}
            {a.version === null ? '' : `, version ${a.version}`}, sha256 <code>{a.sha256}</code>
          </p>
          {a.markdown === null ? null : <pre className="code">{a.markdown}</pre>}
        </section>
      ))}
      <GateDecide id={id} csrf={csrf} artefacts={v} />
    </>
  );
}
