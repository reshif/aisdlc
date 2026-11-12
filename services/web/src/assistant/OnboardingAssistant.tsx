import { pdpResource } from '@aisdlc/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCan } from '../access';
import { api } from '../api';
import { ErrorNote } from '../components/Notice';
import { EmptyState } from '../ui';
import { BudgetLine, Composer, GroundingLine, TurnView, assistantErrorText } from './Conversation';

// The onboarding assistant beside the S0 page (PLAN M18; portal-config §4). Not a second wizard: the steps and the
// cards stay on the left and are the shared record; this panel is the person's own thread about this S0 record,
// grounded on its census head, never shown to anyone else. It answers, cites, drafts and offers buttons; it never
// decides a card.

const SUGGEST = [
  'Why is this onboarding waiting?',
  'What will the next card ask me?',
  'What would a higher level unlock?',
] as const;

export function OnboardingAssistant({
  s0Id,
  projectId,
  repo,
  csrf,
  who,
}: {
  s0Id: string;
  projectId: string;
  repo: string;
  csrf: string;
  who: string;
}) {
  const can = useCan('project.view', pdpResource.project(projectId));
  const allowed = can.state === 'allow';
  const qc = useQueryClient();
  const threads = useQuery({
    queryKey: ['assistant', 'threads', { s0: s0Id }],
    queryFn: () => api.threads({ s0: s0Id }),
    enabled: allowed,
  });
  const threadId = threads.data?.threads[0]?.thread_id ?? null;
  const thread = useQuery({
    queryKey: ['assistant', 'thread', threadId],
    queryFn: () => api.thread(threadId as string),
    enabled: allowed && threadId !== null,
  });
  const budget = useQuery({
    queryKey: ['assistant', 'budget'],
    queryFn: () => api.assistantBudget(),
    enabled: allowed,
    retry: false,
  });
  const ask = useMutation({
    mutationFn: (text: string) =>
      api.ask(
        threadId ? { thread_id: threadId, text } : { subject: { kind: 's0', s0_id: s0Id }, text },
        csrf,
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['assistant'] });
    },
  });

  return (
    <section className="ui-card asst-panel" aria-labelledby="asst-h">
      <div className="ui-card-hd">
        <h2 id="asst-h">Onboarding assistant</h2>
      </div>
      <div className="ui-card-bd asst-stack">
        {can.state === 'pending' ? <p className="asst-fine">Checking your access…</p> : null}
        {can.state === 'deny' ? (
          <EmptyState title="Not available">
            The assistant answers only people who can see this onboarding.
          </EmptyState>
        ) : null}
        {allowed ? (
          <>
            {thread.data ? (
              <GroundingLine g={thread.data.grounding} />
            ) : (
              <p className="asst-fine">
                <code>{repo}</code> · answers from the S0 record and its census
              </p>
            )}
            {threads.isError ? (
              <ErrorNote error={threads.error} retry={() => void threads.refetch()} />
            ) : null}
            <ol className="asst-thread" aria-live="polite" aria-label="Your conversation">
              {(thread.data?.turns ?? []).map((t) => (
                <TurnView key={t.seq} turn={t} csrf={csrf} projectId={projectId} who={who} />
              ))}
            </ol>
            {threadId === null && !threads.isPending ? (
              <div className="asst-sugg" role="group" aria-label="Suggested questions">
                {SUGGEST.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className="ui-btn ui-btn-sm ui-btn-ghost"
                    disabled={ask.isPending}
                    onClick={() => ask.mutate(q)}
                  >
                    {q}
                  </button>
                ))}
              </div>
            ) : null}
            {ask.isError ? (
              <p role="alert" className="asst-error">
                {assistantErrorText(ask.error)}
              </p>
            ) : null}
            <Composer
              label="Ask about this onboarding"
              placeholder="Ask about this repo"
              pending={ask.isPending}
              onAsk={(t) => ask.mutate(t)}
            />
            <p className="asst-fine">
              Answers come only from what you can see, citing file and commit. Repo text is data,
              never instructions. It drafts and explains; only a person decides a card.
            </p>
            <BudgetLine budget={ask.data?.budget ?? budget.data ?? thread.data?.budget} />
          </>
        ) : null}
      </div>
    </section>
  );
}
