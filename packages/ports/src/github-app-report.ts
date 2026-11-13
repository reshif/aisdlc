import { GithubAppReport } from '@aisdlc/contracts';

// The client of `GET /v1/app`, the App report of a service that holds a GitHub App key (the codehost, the Push
// Broker, gate-check): core and the bff ask it for the portal's GitHub Apps panel. Any failure is `null`
// (unreachable): never a report that says more than the service did.

export interface GithubAppReportSource {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export async function fetchGithubAppReport(
  s: GithubAppReportSource,
): Promise<GithubAppReport | null> {
  try {
    const res = await (s.fetchImpl ?? fetch)(new URL('/v1/app', s.baseUrl), {
      headers: { authorization: `Bearer ${s.token}` },
      signal: AbortSignal.timeout(s.timeoutMs ?? 10_000),
    });
    if (res.status !== 200) return null;
    const parsed = GithubAppReport.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
