import type { ConfigKeySummary } from '@aisdlc/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Loading, PageError } from '../components/Notice';
import { ConfigConsole } from '../config/ConfigConsole';
import { Link } from '../router';
import { Card, PageHead, Pill, Table } from '../ui';

// Govern > Configuration: the registered keys of the factory layer, and one key in the console.

export function ConfigListPage() {
  const q = useQuery({ queryKey: ['config-keys'], queryFn: () => api.configKeys() });
  if (q.isPending) return <Loading what="the configuration keys" />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  return (
    <>
      <PageHead
        eyebrow="Govern"
        title="Configuration"
        sub="Every key the factory's configuration may hold. A change is proposed here and takes effect only after its M1 gate is decided."
      />
      <Card title="Registered keys" flush>
        <Table<ConfigKeySummary>
          caption="Registered configuration keys"
          captionHidden
          rows={q.data.keys}
          rowKey={(k) => k.key}
          columns={[
            {
              key: 'key',
              header: 'Key',
              rowHeader: true,
              render: (k) => (
                <Link to={`/config/${encodeURIComponent(k.key)}`}>
                  <code>{k.key}</code>
                </Link>
              ),
            },
            {
              key: 'kind',
              header: 'Kind',
              render: (k) => <Pill plain>{k.kind === 'ops_flag' ? 'ops flag' : 'setting'}</Pill>,
            },
            {
              key: 'scope',
              header: 'Layers',
              render: (k) => (k.overridable ? 'factory, project' : 'factory only'),
            },
            { key: 'd', header: 'What it is', render: (k) => k.description },
          ]}
        />
      </Card>
    </>
  );
}

export function ConfigKeyPage({ configKey, csrf }: { configKey: string; csrf: string }) {
  return (
    <>
      <PageHead
        eyebrow="Govern · Configuration"
        title={<code>{configKey}</code>}
        crumbs={[{ label: 'Configuration', to: '/config' }, { label: configKey }]}
        renderLink={(to, label) => <Link to={to}>{label}</Link>}
      />
      <ConfigConsole configKey={configKey} csrf={csrf} />
    </>
  );
}
