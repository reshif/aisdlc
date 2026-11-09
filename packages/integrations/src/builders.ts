import {
  INTEGRATION_FORBIDDEN,
  type Integration,
  type IntegrationAdapter,
  type IntegrationScope,
} from '@aisdlc/contracts';

// Builders for registry rows: the seed uses them for the first rows, tests for the rest. They only fill
// in what every row of a kind has (scopes with the D11 list, provider facts); nothing here is policy.

const scope = (
  s: IntegrationScope['scope'],
  data_class_max: IntegrationScope['data_class_max'],
): IntegrationScope => ({
  scope: s,
  data_class_max,
  forbidden: [...INTEGRATION_FORBIDDEN],
});

/** An integration of kind `model_provider`. Defaults: enabled, chat_complete up to D2, no credential. */
export function modelProviderRow(
  integration_id: string,
  adapter: Extract<IntegrationAdapter, 'anthropic' | 'openai_compat' | 'fake'>,
  over: Partial<Integration> = {},
): Integration {
  return {
    integration_id,
    kind: 'model_provider',
    adapter,
    display_name: integration_id,
    config: {},
    status: 'enabled',
    version: 1,
    credentials: [],
    scopes: [scope('chat_complete', 'D2')],
    provider: { tools_capable: true, streams: true, aws_only: false },
    ...over,
  };
}

/** An integration of kind `code_host` (the GitHub App). Defaults: enabled, read_repos at D2. */
export function codeHostRow(
  integration_id: string,
  adapter: Extract<IntegrationAdapter, 'github_app' | 'fake_github'>,
  config: Record<string, unknown>,
  over: Partial<Integration> = {},
): Integration {
  return {
    integration_id,
    kind: 'code_host',
    adapter,
    display_name: integration_id,
    config,
    status: 'enabled',
    version: 1,
    credentials: [],
    scopes: [scope('read_repos', 'D2')],
    ...over,
  };
}

export const integrationScope = scope;
