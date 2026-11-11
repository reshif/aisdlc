import type { Tripwire } from './types.js';

// What a Bash command the agent is about to run is: ordinary, an irreversible operation (X1), a new dependency
// (X3), a read of a secret, or the hunt for credentials (ET10). Pure string work over ONE command line; a
// classification is a reason to stop the agent BEFORE the command runs, never a proof that a command is safe.
// The container is the boundary (SEC-OB-3); this is the factory noticing intent, so a session that goes looking
// for credentials is quarantined and a session that is about to do something that cannot be undone is asked about.

/** Environment variable names that hold a secret the sandbox is given (the gateway key) or must never see. */
const SECRET_VARS =
  /\b(AISDLC_GATEWAY_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\b/;

/** Places credentials live. A read of one of these is a secret access. */
export const SECRET_PATH =
  /(^|\/)(\.env(\.[\w.-]+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.docker\/config\.json|\.aws\/credentials|\.ssh\/[^/]*|id_(rsa|dsa|ecdsa|ed25519)|[^/]*\.pem|[^/]*\.p12|[^/]*\.pfx|[^/]*\.key|credentials(\.json)?|secrets?(\.ya?ml|\.json|\.toml)?|kubeconfig|\.kube\/config)$|^\/etc\/(shadow|gshadow|sudoers)|^\/proc\/[^/]+\/environ$|^\/proc\/self\/(environ|mem)$|docker\.sock$/i;

const HUNT: Array<{ re: RegExp; what: string }> = [
  { re: /\b(printenv|env)\s*($|[|;&>])/, what: 'dumps the environment' },
  { re: /(^|[\s;&|])set\s*($|[|;&>])/, what: 'dumps the shell variables' },
  { re: /\/proc\/(self|\d+|\*)\/environ/, what: 'reads another process environment' },
  {
    re: /169\.254\.169\.254|metadata\.google\.internal|100\.100\.100\.200/,
    what: 'asks the cloud metadata service',
  },
  {
    re: /\bfind\s+\/(\s|$)[^|;&]*(-name|-iname)\s+['"]?[^\s'"]*(\.pem|id_rsa|\.env|credential|secret|\.key|token)/i,
    what: 'searches the filesystem for key files',
  },
  {
    re: /\b(grep|rg|ag)\b[^|;&]*(-[a-z]*r[a-z]*|--recursive)[^|;&]*\s\/(\s|$|[a-z])/i,
    what: 'searches the whole filesystem for text',
  },
  {
    re: /\b(grep|rg)\b[^|;&]*\b(password|passwd|secret|api[_-]?key|token|BEGIN (RSA|OPENSSH|EC) PRIVATE)/i,
    what: 'greps for credentials',
  },
  { re: /docker\.sock|containerd\.sock|\/var\/run\/docker/, what: 'looks for the Docker socket' },
  {
    re: /\b(aws|gcloud|az)\s+(configure|auth|sts|iam|secretsmanager|ssm)\b/,
    what: 'asks a cloud CLI for credentials',
  },
  {
    re: /\bcat\s+[^|;&]*(\/etc\/(shadow|passwd)|\.ssh\/|\.aws\/|\.netrc|\.git-credentials)/,
    what: 'reads a credential file',
  },
];

const IRREVERSIBLE: Array<{ re: RegExp; what: string }> = [
  {
    re: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*[fF]?|-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b[^|;&]*\s(\/|~|\$HOME|\.|\.\.|\*|\.\/\*|\/\*)(\s|$|\/)/,
    what: 'recursive removal of the root, home, the repository or everything',
  },
  { re: /\bgit\s+push\b[^|;&]*(--force\b|--force-with-lease|\s-f\b|\s\+\S)/, what: 'a force push' },
  { re: /\bgit\s+reset\s+--hard\b/, what: 'git reset --hard' },
  { re: /\bgit\s+clean\b[^|;&]*-[a-zA-Z]*f/, what: 'git clean -f' },
  {
    re: /\bgit\s+(branch\s+-D|push\s+\S+\s+--delete|push\s+\S+\s+:\S+)/,
    what: 'deleting a branch',
  },
  { re: /\bdrop\s+(table|database|schema)\b/i, what: 'DROP of a table, database or schema' },
  { re: /\btruncate\s+table\b/i, what: 'TRUNCATE TABLE' },
  { re: /\bdelete\s+from\s+\w+\s*(;|$)/i, what: 'DELETE FROM with no WHERE' },
  { re: /\b(mkfs(\.\w+)?|fdisk|wipefs|shred)\b/, what: 'a disk-destroying tool' },
  { re: /\bdd\b[^|;&]*\bof=\/dev\//, what: 'dd onto a device' },
  {
    re: /\b(terraform|tofu)\s+(destroy|apply\s+-auto-approve)\b/,
    what: 'terraform destroy or auto-approved apply',
  },
  { re: /\bkubectl\s+(delete|drain)\b/, what: 'kubectl delete' },
  {
    re: /\b(npm|yarn|pnpm)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/,
    what: 'publishing a package',
  },
];

/** `npm install` with no package is an install of what is already declared (not a new dependency); with one it is. */
const NEW_DEP: Array<{ re: RegExp; what: string }> = [
  { re: /\b(npm|pnpm|bun)\s+(i|install|add)\s+(?!-)[^\s|;&]+/, what: 'npm install of a package' },
  {
    re: /\b(npm|pnpm|bun)\s+(i|install|add)\s+(-[-\w]+\s+)+(?!-)[^\s|;&]+/,
    what: 'npm install of a package',
  },
  { re: /\byarn\s+add\b/, what: 'yarn add' },
  {
    re: /\bpip3?\s+install\s+(?!-r\b|--requirement\b|-e\b|\.|--upgrade\s+pip\b)(-[-\w]+\s+)*[^\s|;&-][^\s|;&]*/,
    what: 'pip install of a package',
  },
  {
    re: /\bpoetry\s+add\b|\buv\s+(add|pip\s+install)\b|\bpipenv\s+install\s+\S/,
    what: 'a Python dependency added',
  },
  {
    re: /\bcargo\s+(add|install)\b|\bgo\s+(get|install)\s+\S|\bgem\s+install\b|\bbundle\s+add\b|\bcomposer\s+(require|global)\b/,
    what: 'a dependency added',
  },
];

const trim = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 200);

/** Names a secret variable the command expands or prints (`$AISDLC_GATEWAY_KEY`, `echo ${ANTHROPIC_API_KEY}`, `process.env.X`). */
const readsSecretVar = (cmd: string): string | null => {
  const m = SECRET_VARS.exec(cmd);
  return m ? (m[1] as string) : null;
};

/** The tripwires one Bash command raises, in order of weight. Never includes the command's text beyond a short, secret-free reason. */
export function classifyCommand(cmd: string): Tripwire[] {
  const out: Tripwire[] = [];
  const text = cmd.slice(0, 8_192);
  const v = readsSecretVar(text);
  if (v !== null) {
    out.push({
      kind: 'secret_access',
      class: 'quarantine',
      detail: `a command reads the secret variable ${v}`,
    });
  }
  for (const w of text.split(/\s+/)) {
    if (SECRET_PATH.test(w.replace(/^['"]|['"]$/g, ''))) {
      out.push({
        kind: 'secret_access',
        class: 'quarantine',
        detail: `a command names a credential path (${trim(w).slice(0, 80)})`,
      });
      break;
    }
  }
  for (const h of HUNT) {
    if (h.re.test(text)) {
      out.push({ kind: 'credential_hunting', class: 'quarantine', detail: `a command ${h.what}` });
      break;
    }
  }
  for (const i of IRREVERSIBLE) {
    if (i.re.test(text)) {
      out.push({ kind: 'irreversible_operation', class: 'gate_x1', detail: i.what });
      break;
    }
  }
  for (const d of NEW_DEP) {
    if (d.re.test(text)) {
      out.push({ kind: 'new_dependency', class: 'gate_x3', detail: d.what });
      break;
    }
  }
  return out;
}
