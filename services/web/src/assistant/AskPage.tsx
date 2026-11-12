import type { Thread } from '@aisdlc/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { ErrorNote, Loading } from '../components/Notice';
import { shortTime } from '../format';
import { Card, EmptyState, PageHead, Pill } from '../ui';
import { BudgetLine, Composer, GroundingLine, TurnView, assistantErrorText } from './Conversation';

// "Ask the factory" (PLAN M18; the design reference's chat view): the person's own conversations, each about one
// project (or one onboarding), answered only from what the person can see, every source cited, actions only through
// buttons the PDP checks. The threads are the person's; nobody else sees them.

const subjectText = (t: Thread): string =>
  t.subject.kind === 's0'
    ? `onboarding · ${t.subject.project_id}`
    : `ask · ${t.subject.project_id}`;

export function AskPage({ csrf, who }: { csrf: string; who: string }) {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.projects() });
  const threads = useQuery({
    queryKey: ['assistant', 'threads', {}],
    queryFn: () => api.threads({}),
  });
  const budget = useQuery({
    queryKey: ['assistant', 'budget'],
    queryFn: () => api.assistantBudget(),
    retry: false,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [fresh, setFresh] = useState(false);
  const [project, setProject] = useState<string>('');
  const list = threads.data?.threads ?? [];
  const current = fresh ? null : (selected ?? list[0]?.thread_id ?? null);
  const thread = useQuery({
    queryKey: ['assistant', 'thread', current],
    queryFn: () => api.thread(current as string),
    enabled: current !== null,
  });
  const visible = projects.data ?? [];
  const target = project || visible[0]?.project.project_id || '';
  const ask = useMutation({
    mutationFn: (text: string) =>
      api.ask(
        current
          ? { thread_id: current, text }
          : { subject: { kind: 'project', project_id: target }, text },
        csrf,
      ),
    onSuccess: async (r) => {
      setFresh(false);
      setSelected(r.thread.thread_id);
      await qc.invalidateQueries({ queryKey: ['assistant'] });
    },
  });

  return (
    <>
      <PageHead
        title="Ask the factory"
        sub="Ask about your work, the code at the census head and the record. It answers only from what you can see yourself, cites every source, and acts only through buttons the PDP checks."
        actions={
          <button
            type="button"
            className="ui-btn"
            onClick={() => {
              setFresh(true);
              setSelected(null);
            }}
          >
            New conversation
          </button>
        }
      />
      <BudgetLine budget={ask.data?.budget ?? budget.data} />
      <div className="asst-chat">
        <div className="asst-side">
          <Card title="Your conversations" flush>
            {threads.isPending ? <Loading what="your conversations" /> : null}
            {threads.isError ? (
              <ErrorNote error={threads.error} retry={() => void threads.refetch()} />
            ) : null}
            {threads.data && list.length === 0 ? (
              <p className="asst-fine asst-pad">No conversations yet.</p>
            ) : null}
            <ul className="asst-threads" aria-label="Your conversations">
              {list.map((t) => (
                <li key={t.thread_id}>
                  <button
                    type="button"
                    className="asst-thread-btn"
                    aria-current={t.thread_id === current}
                    onClick={() => {
                      setFresh(false);
                      setSelected(t.thread_id);
                    }}
                  >
                    <span className="asst-thread-title">{t.title}</span>
                    <span className="asst-fine">
                      {subjectText(t)} · {t.turns} turns · {shortTime(t.updated_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="What it can see for you">
            <ul className="plain asst-fine">
              <li>
                <Pill tone="ok" plain>
                  reads
                </Pill>{' '}
                the {visible.length} project{visible.length === 1 ? '' : 's'} you can view, at your
                data class (D1 at most)
              </li>
              <li>
                <Pill tone="bad" plain>
                  never
                </Pill>{' '}
                projects you have no role on, open branches, secrets, other people&apos;s
                conversations
              </li>
              <li>
                <Pill tone="gate" plain>
                  acts
                </Pill>{' '}
                only through buttons that call the same routes you would; the PDP decides
              </li>
            </ul>
          </Card>
        </div>
        <Card
          className="asst-conv"
          title={current ? (thread.data?.thread.title ?? 'Conversation') : 'New conversation'}
        >
          {current === null ? (
            visible.length === 0 ? (
              <EmptyState title="No project to ask about">
                The assistant answers about projects you can see. You can see none yet.
              </EmptyState>
            ) : (
              <p className="asst-fine">
                <label htmlFor="asst-project">About project </label>
                <select
                  id="asst-project"
                  value={target}
                  onChange={(e) => setProject(e.target.value)}
                >
                  {visible.map((p) => (
                    <option key={p.project.project_id} value={p.project.project_id}>
                      {p.project.name}
                    </option>
                  ))}
                </select>
              </p>
            )
          ) : (
            <GroundingLine g={thread.data?.grounding} />
          )}
          {thread.isError ? (
            <ErrorNote error={thread.error} retry={() => void thread.refetch()} />
          ) : null}
          <ol className="asst-thread" aria-live="polite" aria-label="Conversation">
            {(current ? (thread.data?.turns ?? []) : []).map((t) => (
              <TurnView
                key={t.seq}
                turn={t}
                csrf={csrf}
                projectId={thread.data?.thread.subject.project_id ?? target}
                who={who}
              />
            ))}
          </ol>
          {ask.isError ? (
            <p role="alert" className="asst-error">
              {assistantErrorText(ask.error)}
            </p>
          ) : null}
          {current !== null || visible.length > 0 ? (
            <Composer
              label="Message"
              placeholder="Ask about an item, an onboarding, or the code at the census head…"
              pending={ask.isPending}
              onAsk={(t) => ask.mutate(t)}
            />
          ) : null}
          <p className="asst-fine">
            Answers cite files at the census head and records. The assistant cannot change anything.
            Secrets you paste are masked before any model sees them.
          </p>
        </Card>
      </div>
    </>
  );
}
