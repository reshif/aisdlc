import { HARNESS_FILE_PATTERNS } from '@aisdlc/contracts';
import { matchesAny } from '@aisdlc/tripwires';

/**
 * The environment the agent harness (the Claude Agent SDK's process, and so every Bash command it runs) gets. It is
 * built from nothing, not from the runner's own environment: PATH, a HOME on the sandbox's scratch, the gateway's
 * URL and the Unit's virtual key as the API key (the ONE credential, and only as this environment variable), and
 * the switches that keep the harness quiet and its tool set exactly the contract's: no telemetry, no update check,
 * no tool search (whose placeholder tool the gateway's allow-list would refuse), no experimental betas.
 */
export function sessionEnv(o: {
  gatewayUrl: string;
  gatewayKey: string;
  home: string;
  path: string;
}): Record<string, string> {
  return {
    PATH: o.path,
    HOME: o.home,
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    CI: '1',
    ANTHROPIC_BASE_URL: o.gatewayUrl,
    ANTHROPIC_API_KEY: o.gatewayKey,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    CLAUDE_CODE_DISABLE_THINKING: '1',
    DISABLE_PROMPT_CACHING: '1',
    CLAUDE_CODE_DISABLE_ATTRIBUTION_HEADER: '1',
    ENABLE_TOOL_SEARCH: 'false',
  };
}

/** The harness files a tree carries (CLAUDE.md, AGENTS.md, `.claude/`, `.mcp.json`...): listed as ignored, never loaded. */
export const harnessFilesIn = (paths: readonly string[]): string[] =>
  paths.filter((p) => matchesAny(p, HARNESS_FILE_PATTERNS)).sort();
