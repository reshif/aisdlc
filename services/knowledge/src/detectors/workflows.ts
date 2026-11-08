import {
  WORKFLOW_RULE_SEVERITY,
  type AomRule,
  type DetectorEvidence,
  type Fact,
  type WorkflowRule,
} from '@aisdlc/contracts';
import { globRegex } from './paths.js';
import { parseYamlSafe, yamlLine, type YamlDoc } from './safe-parse.js';
import { Collector, type Detector, type TreeFile, type TreeReader } from './types.js';

// B5 dangerous-workflow check and B6 apply-on-merge detector (PLAN M6.3; OB §5.2, §5.4 Phase A
// "minimal in-house check"). Workflows are parsed with the safe YAML parser and only READ: nothing
// is run, and no expression is evaluated. A workflow that cannot be parsed or is over the limits is
// a coverage item and makes B5 `unknown` (counts as unmet), never "no finding".
//
// B5 RED (blocks agent-code lanes):
//   pr_target_head_checkout / workflow_run_head_checkout   a `pull_request_target` or `workflow_run`
//        workflow checks out the PR head: a checkout step whose `ref` or `repository` is the PR head
//        (github.event.pull_request.head.*, github.head_ref, workflow_run head_*, refs/pull/*), or
//        `gh pr checkout` in a run step.
//   secrets_on_pr_trigger     a secret (any `secrets.X` except GITHUB_TOKEN, or `secrets: inherit`) in
//        a workflow triggered by pull_request, pull_request_target, pull_request_review(_comment).
//   secrets_on_agent_trigger  the same on a `push` that applies to `agent/**` branches (no branch
//        filter, or one that matches `agent/x`).
//   untrusted_context_in_run  `${{ github.event.* }}` interpolated inside a `run:` (or github-script
//        `script:`) unless the field is a known-safe number, id, sha or login; and `github.head_ref`
//        or `github.ref_name`. Taint through step outputs and env is not followed (documented gap).
// B5 AMBER (posture):
//   unpinned_action_with_secrets  a third-party action (not actions/*, github/*, not local) not pinned
//        to a 40-hex commit, in a workflow that uses a secret.
//   missing_permissions_on_writing_workflow  no `permissions:` at the workflow level nor on every
//        job, in a workflow that writes (git push, gh release/pr/issue, publish, deploy, or a known
//        writing action).

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;
export const MAX_WORKFLOWS = 100;
const WORKFLOW_LIMIT = 512 * 1024;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const asStrings = (v: unknown): string[] =>
  typeof v === 'string'
    ? [v]
    : Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string')
      : [];

export interface Workflow {
  readonly file: TreeFile;
  readonly text: string;
  readonly y: YamlDoc;
  readonly root: Obj;
  /** event name -> its config (object, or null for `push:` with no body or the list form). */
  readonly triggers: Map<string, Obj | null>;
  readonly jobs: Array<{ id: string; job: Obj }>;
}

/** Loads and parses every workflow; an unparseable one is a coverage item and counted. */
export async function loadWorkflows(
  reader: TreeReader,
  c: Collector,
): Promise<{ workflows: Workflow[]; unanalysed: number }> {
  const paths = reader.files.filter((f) => WORKFLOW_PATH.test(f.path));
  let unanalysed = 0;
  const out: Workflow[] = [];
  if (paths.length > MAX_WORKFLOWS) {
    c.capped('workflow files', MAX_WORKFLOWS);
    unanalysed += paths.length - MAX_WORKFLOWS;
  }
  for (const f of paths.slice(0, MAX_WORKFLOWS)) {
    const t = await c.text(f.path, WORKFLOW_LIMIT);
    if (!t) {
      unanalysed++;
      continue;
    }
    const p = parseYamlSafe(t.text, WORKFLOW_LIMIT);
    if (!p.ok) {
      c.unparseable(t.file, p.why);
      unanalysed++;
      continue;
    }
    const root = p.value.value;
    if (!isObj(root)) {
      c.unparseable(t.file, 'not a workflow (the document is not a mapping)');
      unanalysed++;
      continue;
    }
    const on = 'on' in root ? root['on'] : (root as Record<string, unknown>)['true'];
    const triggers = new Map<string, Obj | null>();
    if (typeof on === 'string') triggers.set(on, null);
    else if (Array.isArray(on)) for (const e of asStrings(on)) triggers.set(e, null);
    else if (isObj(on))
      for (const [e, cfg] of Object.entries(on)) triggers.set(e, isObj(cfg) ? cfg : null);
    const jobs = isObj(root['jobs'])
      ? Object.entries(root['jobs'])
          .filter((e): e is [string, Obj] => isObj(e[1]))
          .map(([id, job]) => ({ id, job }))
      : [];
    out.push({ file: t.file, text: t.text, y: p.value, root, triggers, jobs });
  }
  return { workflows: out, unanalysed };
}

// ---------------------------------------------------------------- triggers

/** Does a `push` / `pull_request` branch filter let `branch` through? GitHub semantics for the cases that matter. */
export function branchAllowed(cfg: Obj | null, branch: string): boolean {
  if (cfg === null) return true;
  const inc = asStrings(cfg['branches']);
  const exc = asStrings(cfg['branches-ignore']);
  const tagsOnly =
    (cfg['tags'] !== undefined || cfg['tags-ignore'] !== undefined) &&
    inc.length === 0 &&
    exc.length === 0;
  if (tagsOnly) return false; // defining only tags means branch pushes do not run it
  if (inc.length > 0) {
    let ok = false;
    for (const pat of inc) {
      if (pat.startsWith('!')) {
        if (globRegex(pat.slice(1)).test(branch)) ok = false;
      } else if (globRegex(pat).test(branch)) ok = true;
    }
    return ok;
  }
  if (exc.length > 0) return !exc.some((pat) => globRegex(pat).test(branch));
  return true;
}

const PR_EVENTS = [
  'pull_request',
  'pull_request_target',
  'pull_request_review',
  'pull_request_review_comment',
] as const;

/** Lines of the raw text where `secrets.X` (not GITHUB_TOKEN) or `secrets: inherit` is used, comments skipped. */
export function secretLines(text: string): number[] {
  const out: number[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const l = raw.replace(/(^|\s)#.*$/, '');
    if (/^\s*secrets\s*:\s*inherit\b/.test(l)) out.push(i + 1);
    else
      for (const m of l.matchAll(/\bsecrets\.([A-Za-z0-9_-]+)/g))
        if (m[1] !== 'GITHUB_TOKEN') {
          out.push(i + 1);
          break;
        }
  });
  return out;
}

interface Step {
  readonly job: string;
  readonly index: number;
  readonly step: Obj;
}
function* steps(w: Workflow): Generator<Step> {
  for (const { id, job } of w.jobs) {
    if (!Array.isArray(job['steps'])) continue;
    for (const [index, s] of (job['steps'] as unknown[]).entries())
      if (isObj(s)) yield { job: id, index, step: s };
  }
}

/** Line of a step field; the step's own line when the field has none. */
const stepLine = (w: Workflow, s: Step, field: string): number =>
  yamlLine(
    w.y,
    w.y.doc.getIn(['jobs', s.job, 'steps', s.index, field], true) ??
      w.y.doc.getIn(['jobs', s.job, 'steps', s.index], true),
  );

/** The line inside a multi-line scalar where `snippet` is, falling back to the scalar's first line. */
function lineInScalar(w: Workflow, path: Array<string | number>, snippet: string): number {
  const node = w.y.doc.getIn(path, true) as { range?: [number, number, number] } | undefined;
  const start = yamlLine(w.y, node);
  if (!node?.range) return start;
  const raw = w.text.slice(node.range[0], node.range[1]);
  const at = raw.indexOf(snippet);
  return at === -1 ? start : start + raw.slice(0, at).split('\n').length - 1;
}

// ---------------------------------------------------------------- B5

const HEAD_REF =
  /github\.event\.pull_request\.head\.|github\.head_ref|github\.event\.pull_request\.merge_commit_sha|refs\/pull\/|github\.event\.workflow_run\.(?:head_sha|head_branch|head_repository|pull_requests)|github\.event\.number|github\.event\.issue\.pull_request/;

const SAFE_EVENT_FIELD = new RegExp(
  '^(?:number|action|before|after|id|run_id|run_number|' +
    'workflow_run\\.(?:id|run_number|run_attempt|conclusion|status|event|head_sha|workflow_id)|' +
    '(?:pull_request|issue)\\.(?:number|id|state|draft|merged|locked|author_association|user\\.(?:login|id|type)|base\\.sha|head\\.sha)|' +
    'repository\\.(?:id|full_name|name|owner\\.login|default_branch|private|fork)|' +
    'sender\\.(?:login|id|type)|organization\\.login|installation\\.id|head_commit\\.id)$',
);

/** Attacker-controlled (or not known safe) contexts inside one `${{ }}` expression. */
export function unsafeContexts(expr: string): string[] {
  const out: string[] = [];
  for (const m of expr.matchAll(/\bgithub\.event\.([A-Za-z0-9_.[\]*'-]+)/g)) {
    const field = (m[1] as string).replace(/\[[^\]]*\]/g, '').replace(/\.$/, '');
    if (!SAFE_EVENT_FIELD.test(field)) out.push(`github.event.${field}`);
  }
  if (/\bgithub\.head_ref\b/.test(expr)) out.push('github.head_ref');
  if (/\bgithub\.ref_name\b/.test(expr)) out.push('github.ref_name');
  return out;
}

const WRITE_COMMAND =
  /\bgit\s+push\b|\bgh\s+(?:release|pr|issue|api|workflow|repo|label)\b|\bnpm\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bdocker\s+push\b|\bterraform\s+apply\b|\bkubectl\s+apply\b|\bhelm\s+(?:upgrade|install)\b|\bgcloud\s+\S+\s+deploy\b|\baws\s+(?:s3\s+(?:sync|cp)|cloudformation\s+deploy)\b/;
const WRITE_ACTION =
  /^(?:actions\/(?:create-release|deploy-pages|upload-release-asset)|softprops\/action-gh-release|peter-evans\/create-pull-request|peter-evans\/create-or-update-comment|JamesIves\/github-pages-deploy-action|peaceiris\/actions-gh-pages|stefanzweig\/|ncipollo\/release-action|marvinpinto\/action-automatic-releases|EndBug\/add-and-commit|stefanzhang\/|github\/codeql-action\/upload-sarif|docker\/build-push-action)\b/;

export function evidenceOf(c: Collector, w: Workflow, line: number): DetectorEvidence {
  return c.evidence(w.file, line);
}

export function b5Detector(): Detector {
  return {
    info: { id: 'b5_workflows', version: '1', criteria: ['RS-SEC'] },
    async run(reader: TreeReader) {
      const c = new Collector('b5_workflows', reader);
      const { workflows, unanalysed } = await loadWorkflows(reader, c);
      c.stats['workflows_unanalysed'] = unanalysed;
      c.stats['workflows_analysed'] = workflows.length;
      for (const w of workflows) analyse(c, w);
      return c.output();
    },
  };
}

function analyse(c: Collector, w: Workflow): void {
  const found = new Set<string>();
  const emit = (rule: WorkflowRule, job: string | null, line: number): void => {
    const key = `${rule}\0${job ?? ''}\0${line}`;
    if (found.has(key)) return;
    found.add(key);
    c.add({
      kind: 'workflow_finding',
      detector: 'b5_workflows',
      rule,
      severity: WORKFLOW_RULE_SEVERITY[rule],
      path: w.file.path,
      job,
      evidence: [evidenceOf(c, w, line)],
    });
  };

  // Head checkout under pull_request_target / workflow_run.
  const headRules: Array<[string, WorkflowRule]> = [
    ['pull_request_target', 'pr_target_head_checkout'],
    ['workflow_run', 'workflow_run_head_checkout'],
  ];
  for (const [event, rule] of headRules) {
    if (!w.triggers.has(event)) continue;
    for (const s of steps(w)) {
      const uses = typeof s.step['uses'] === 'string' ? s.step['uses'] : '';
      const withObj = isObj(s.step['with']) ? s.step['with'] : {};
      if (/checkout/i.test(uses)) {
        for (const field of ['ref', 'repository']) {
          const v = withObj[field];
          if (typeof v === 'string' && HEAD_REF.test(v))
            emit(
              rule,
              s.job,
              yamlLine(w.y, w.y.doc.getIn(['jobs', s.job, 'steps', s.index, 'with', field], true)),
            );
        }
      }
      const run = typeof s.step['run'] === 'string' ? s.step['run'] : '';
      if (
        /\bgh\s+pr\s+checkout\b/.test(run) ||
        (/\bgit\s+(?:checkout|fetch|switch)\b/.test(run) && HEAD_REF.test(run))
      )
        emit(rule, s.job, stepLine(w, s, 'run'));
    }
  }

  // Secrets on PR or agent/** triggers.
  const secrets = secretLines(w.text);
  if (secrets.length > 0) {
    const prTrigger = PR_EVENTS.some((e) => w.triggers.has(e));
    const push = w.triggers.get('push');
    const agentPush = w.triggers.has('push') && branchAllowed(push ?? null, 'agent/task');
    for (const line of secrets.slice(0, 5)) {
      if (prTrigger) emit('secrets_on_pr_trigger', null, line);
      if (agentPush) emit('secrets_on_agent_trigger', null, line);
    }
  }

  // Attacker-controlled contexts interpolated into a shell or script.
  for (const s of steps(w)) {
    const fields: Array<[string, string]> = [];
    if (typeof s.step['run'] === 'string') fields.push(['run', s.step['run']]);
    const withObj = isObj(s.step['with']) ? s.step['with'] : null;
    if (
      typeof s.step['uses'] === 'string' &&
      /github-script/.test(s.step['uses']) &&
      withObj &&
      typeof withObj['script'] === 'string'
    )
      fields.push(['script', withObj['script']]);
    for (const [field, text] of fields) {
      for (const m of text.matchAll(/\$\{\{([\s\S]{1,500}?)\}\}/g)) {
        if (unsafeContexts(m[1] as string).length === 0) continue;
        const path: Array<string | number> = [
          'jobs',
          s.job,
          'steps',
          s.index,
          ...(field === 'run' ? ['run'] : ['with', 'script']),
        ];
        emit('untrusted_context_in_run', s.job, lineInScalar(w, path, m[0]));
      }
    }
  }

  // Amber: unpinned third-party actions where a secret is in play.
  if (secrets.length > 0) {
    const unpinned = (uses: string): boolean => {
      if (uses.startsWith('./') || uses.startsWith('.\\')) return false;
      if (uses.startsWith('docker://')) return !/@sha256:[0-9a-f]{64}$/.test(uses);
      const owner = uses.split('/')[0] ?? '';
      if (owner === 'actions' || owner === 'github') return false;
      return !/@[0-9a-f]{40}$/.test(uses);
    };
    for (const s of steps(w)) {
      const uses = s.step['uses'];
      if (typeof uses === 'string' && unpinned(uses))
        emit('unpinned_action_with_secrets', s.job, stepLine(w, s, 'uses'));
    }
    for (const { id, job } of w.jobs)
      if (typeof job['uses'] === 'string' && unpinned(job['uses']))
        emit(
          'unpinned_action_with_secrets',
          id,
          yamlLine(w.y, w.y.doc.getIn(['jobs', id, 'uses'], true)),
        );
  }

  // Amber: a writing workflow with no `permissions:` (workflow-level, or on every job).
  const hasTop = 'permissions' in w.root;
  const jobsAllSet = w.jobs.length > 0 && w.jobs.every((j) => 'permissions' in j.job);
  if (!hasTop && !jobsAllSet) {
    let writes = false;
    for (const s of steps(w)) {
      const run = typeof s.step['run'] === 'string' ? s.step['run'] : '';
      const uses = typeof s.step['uses'] === 'string' ? s.step['uses'] : '';
      if (WRITE_COMMAND.test(run) || WRITE_ACTION.test(uses)) {
        writes = true;
        break;
      }
    }
    if (writes) emit('missing_permissions_on_writing_workflow', null, 1);
  }
}

// ---------------------------------------------------------------- B6

/** Deploy and apply commands, and the rule each is. Matched per line of a `run` or a CI file. */
export const DEPLOY_COMMANDS: ReadonlyArray<readonly [RegExp, AomRule]> = [
  [/\b(?:terraform|tofu|terragrunt)\s+(?:run-all\s+)?apply\b/, 'terraform_apply'],
  [/\bkubectl\s+(?:apply|rollout|set\s+image|replace|create)\b/, 'kubectl_apply'],
  [/\bhelm\s+(?:upgrade|install)\b|\bhelmfile\s+(?:apply|sync)\b/, 'helm_upgrade'],
  [/\b(?:serverless|sls)\s+deploy\b|\bsam\s+deploy\b/, 'serverless_deploy'],
  [/\bcdk\s+deploy\b/, 'cdk_deploy'],
  [/\bpulumi\s+up\b/, 'pulumi_up'],
  [
    /\bansible-playbook\b|\baws\s+(?:s3\s+sync|cloudformation\s+deploy|ecs\s+update-service|lambda\s+update-function-code|deploy\b|elasticbeanstalk\s+update-environment)|\bgcloud\s+(?:app|run|functions|compute\s+instance-groups\s+managed\s+rolling-action)\s+(?:\S+\s+)?deploy\b|\bgcloud\s+app\s+deploy\b|\baz\s+(?:webapp|functionapp|containerapp|deployment)\s+\S*\s*(?:deploy|up|create|update)\b|\bfirebase\s+deploy\b|\bvercel\s+(?:deploy|--prod)\b|\bnetlify\s+deploy\b|\b(?:flyctl|fly)\s+deploy\b|\bgit\s+push\s+(?:heroku|dokku)\b|\bwrangler\s+(?:deploy|publish)\b|\bcap\s+\S+\s+deploy\b|\bscp\b.*\b(?:prod|production)\b/,
    'cloud_cli_deploy',
  ],
];
const DEPLOY_ACTION =
  /^(?:aws-actions\/(?:amazon-ecs-deploy-task-definition|aws-cloudformation-github-deploy)|azure\/(?:webapps-deploy|k8s-deploy|functions-action|container-apps-deploy-action|arm-deploy)|google-github-actions\/(?:deploy-cloudrun|deploy-appengine|deploy-cloud-functions)|appleboy\/ssh-action|superfly\/flyctl-actions|cloudflare\/wrangler-action|amondnet\/vercel-action|nwtgck\/actions-netlify|netlify\/actions|serverless\/github-action|hashicorp\/tfc-workflows-github|pulumi\/actions|actions\/deploy-pages|JamesIves\/github-pages-deploy-action|peaceiris\/actions-gh-pages|dokku\/github-action|akhileshns\/heroku-deploy|digitalocean\/app_action|easingthemes\/ssh-deploy)\b/;
const NON_DEPLOY_ENV = /^(?:test|tests|testing|ci|unit|lint|coverage)$/i;

const CI_FILES =
  /(?:^|\/)(?:\.gitlab-ci\.ya?ml|\.circleci\/config\.yml|Jenkinsfile|azure-pipelines\.ya?ml|bitbucket-pipelines\.yml|\.travis\.yml|cloudbuild\.ya?ml|buildspec\.ya?ml|appveyor\.yml|\.drone\.yml|bitrise\.yml)$/;
const PLATFORM_FILES =
  /^(?:vercel\.json|netlify\.toml|fly\.toml|render\.yaml|railway\.(?:json|toml)|amplify\.yml|wrangler\.(?:toml|jsonc?)|\.platform\.app\.yaml)$/;
const GITOPS_PATH =
  /(?:^|\/)(?:argo(?:cd)?|gitops|flux|clusters?|apps?|deploy(?:ment)?s?)\/.+\.ya?ml$|(?:^|\/)(?:application|applicationset|kustomization|helmrelease)[\w-]*\.ya?ml$/i;

/** Triggers a deploy on merge: a push to the default branch, or a pull request closed as merged. */
function mergeTrigger(w: Workflow, branches: readonly string[]): string | null {
  const push = w.triggers.get('push');
  if (w.triggers.has('push') && branches.some((b) => branchAllowed(push ?? null, b))) return 'push';
  const pr = w.triggers.get('pull_request') ?? w.triggers.get('pull_request_target');
  if (
    (w.triggers.has('pull_request') || w.triggers.has('pull_request_target')) &&
    pr &&
    asStrings(pr['types']).includes('closed') &&
    /\.merged\b/.test(w.text)
  )
    return 'pull_request_merged';
  return null;
}

export function b6Detector(): Detector {
  return {
    info: { id: 'b6_apply_on_merge', version: '1', criteria: ['RS-OP-1'] },
    async run(reader: TreeReader) {
      const c = new Collector('b6_apply_on_merge', reader);
      const branches = reader.defaultBranch !== null ? [reader.defaultBranch] : ['main', 'master'];
      const facts: Fact[] = [];
      const seen = new Set<string>();
      const add = (
        rule: AomRule,
        confidence: 'high' | 'medium',
        file: TreeFile,
        line: number,
      ): void => {
        const key = `${rule}\0${confidence}\0${file.path}`;
        if (seen.has(key)) return;
        seen.add(key);
        const ev = c.evidence(file, line);
        facts.push({
          kind: 'apply_on_merge',
          detector: 'b6_apply_on_merge',
          rule,
          confidence,
          path: file.path,
          evidence: [ev],
        });
        // Only a high-confidence signal raises the tier floor (a floor can never be lowered again).
        if (confidence === 'high')
          facts.push({
            kind: 'tier_signal',
            detector: 'b6_apply_on_merge',
            signal: `aom.${rule}`,
            criterion: 'blast_radius',
            floor: 'T2',
            evidence: [ev],
          });
      };

      // 1. Workflows: a merge trigger and a deploy step (or a deployment environment).
      const { workflows, unanalysed } = await loadWorkflows(reader, c);
      c.stats['workflows_unanalysed'] = unanalysed;
      for (const w of workflows) {
        const trig = mergeTrigger(w, branches);
        if (trig === null) continue;
        for (const { id, job } of w.jobs) {
          const env = isObj(job['environment']) ? job['environment']['name'] : job['environment'];
          if (typeof env === 'string' && !NON_DEPLOY_ENV.test(env))
            add(
              'workflow_environment',
              'high',
              w.file,
              yamlLine(w.y, w.y.doc.getIn(['jobs', id, 'environment'], true)),
            );
          if (typeof job['uses'] === 'string' && /deploy|release|publish/i.test(job['uses']))
            add(
              'workflow_deploy',
              'high',
              w.file,
              yamlLine(w.y, w.y.doc.getIn(['jobs', id, 'uses'], true)),
            );
        }
        for (const s of steps(w)) {
          const uses = typeof s.step['uses'] === 'string' ? s.step['uses'] : '';
          if (DEPLOY_ACTION.test(uses))
            add('deploy_action', 'high', w.file, stepLine(w, s, 'uses'));
          const run = typeof s.step['run'] === 'string' ? s.step['run'] : '';
          if (run !== '') {
            for (const line of run.split('\n')) {
              if (line.trim().startsWith('#')) continue;
              const hit = DEPLOY_COMMANDS.find(([re]) => re.test(line));
              if (hit) {
                add(
                  hit[1],
                  'high',
                  w.file,
                  lineInScalar(w, ['jobs', s.job, 'steps', s.index, 'run'], line),
                );
                break;
              }
            }
          }
        }
      }

      // 2. Other CI systems: a deploy command, with no branch condition evaluated (medium).
      let reads = 0;
      for (const f of reader.files) {
        if (!CI_FILES.test(f.path)) continue;
        if (reads++ >= 40) {
          c.capped('CI files', 40);
          break;
        }
        const t = await c.text(f.path, 512 * 1024);
        if (!t) continue;
        const lines = t.text.split(/\r?\n/);
        for (const [i, l] of lines.entries()) {
          if (l.trim().startsWith('#')) continue;
          const hit = DEPLOY_COMMANDS.find(([re]) => re.test(l));
          if (hit) {
            add(
              hit[1] === 'cloud_cli_deploy' ? 'ci_deploy_command' : hit[1],
              'medium',
              t.file,
              i + 1,
            );
            break;
          }
        }
      }

      // 3. Platform config that deploys the repo on push (medium: whether the integration is on is not in the repo).
      for (const f of reader.files) {
        const name = f.path.slice(f.path.lastIndexOf('/') + 1);
        if (f.path.includes('/') && !/^\.platform\//.test(f.path)) continue;
        if (PLATFORM_FILES.test(name)) add('platform_config', 'medium', f, 1);
      }

      // 4. GitOps controllers that reconcile on merge (high).
      let gitops = 0;
      for (const f of reader.files) {
        if (!GITOPS_PATH.test(f.path) || /(?:^|\/)(?:node_modules|vendor)\//.test(f.path)) continue;
        if (gitops++ >= 200) {
          c.capped('GitOps candidate files', 200);
          break;
        }
        const t = await c.text(f.path, 256 * 1024);
        if (!t) continue;
        const argo =
          /argoproj\.io/.test(t.text) &&
          /^\s*kind:\s*Application(?:Set)?\b/m.test(t.text) &&
          /^\s*automated\s*:/m.test(t.text);
        const flux =
          /(?:kustomize|helm)\.toolkit\.fluxcd\.io/.test(t.text) &&
          /^\s*kind:\s*(?:Kustomization|HelmRelease)\b/m.test(t.text);
        if (argo || flux) {
          const at = t.text.search(
            argo ? /^\s*automated\s*:/m : /^\s*kind:\s*(?:Kustomization|HelmRelease)\b/m,
          );
          add(
            'gitops_auto_sync',
            'high',
            t.file,
            at === -1 ? 1 : t.text.slice(0, at).split('\n').length + 1,
          );
        }
      }

      for (const f of facts) c.add(f);
      return c.output();
    },
  };
}
