import {
  type DetectorEvidence,
  type DetectorId,
  type Fact,
  type TierAssessment,
} from '@aisdlc/contracts';
import { isOwnSource, isVendored } from './paths.js';
import { Collector, basename, type Detector, type TreeReader } from './types.js';

// Tier-floor detectors (PLAN M6.3; OB §2.2). The tier is what the system IS (its data, exposure and
// blast radius), never how tidy the repo is. These detectors set a FLOOR (T0, T1 or T2) from clear
// heuristics; afterwards only A9 and the owner may raise it. Regulatory and criticality are NEVER
// inferred: they are owner attestation only, and a repo with no attestation is represented as
// unattested so M7.4 can block M4 (R-SEC-T3, DEC-4).
//
// THE HEURISTICS (each signal carries evidence {path, blob, line}):
//  dc.pii            T1  two or more distinct PII-like field kinds (email, phone, name, birth date,
//                        address, IP address, gender) in schema, model, migration, API-schema or
//                        query files. One kind alone (a login e-mail) is not enough.
//  dc.sensitive_pii  T2  any sensitive field name in those files: national id or SSN, passport, tax
//                        id, driver licence, card number, CVV, IBAN, bank account, diagnosis,
//                        patient, health record, prescription, biometric, ethnicity, religion.
//  ex.routing        T1  ingress or routing config: nginx, Caddy, Traefik, HAProxy, Envoy, Apache,
//                        Kubernetes Ingress, Gateway or HTTPRoute, API gateway or load balancer or
//                        CDN in IaC, vercel.json routes, netlify redirects, serverless http events.
//  ex.open           T2  internet-facing or open: wildcard CORS, a public load balancer, a Kubernetes
//                        LoadBalancer Service, 0.0.0.0/0 on an ingress rule, public buckets or
//                        databases, unauthenticated cloud endpoints.
//  br.migration      T1  database migration files or directories.
//  br.iac            T1  infrastructure as code: Terraform, Pulumi, CDK, CloudFormation, Bicep,
//                        Helm charts, Kustomize, Kubernetes manifests, Ansible playbooks.
//  br.prod_inventory T2  production inventory: a prod environment, inventory or variable file in IaC.
//  aom.*             T2  apply-on-merge (see workflows.ts, the B6 detector), high confidence only.
// Test, fixture, example and documentation paths are skipped (their field names are mock data), and
// so are vendored directories. A detector reads at most MAX_READS files, each at most 512 KiB; past
// that a `detector_cap` coverage item says the heuristic saw only part of the tree.

const MAX_READS = 300;
const READ_LIMIT = 512 * 1024;
const MAX_EVIDENCE = 5;

const camelToSnake = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const tok = (alt: string): RegExp => new RegExp(`(?<![a-z0-9])(?:${alt})(?![a-z0-9])`);

const PII: Array<[string, RegExp]> = [
  ['email', tok('e_?mail(?:_?address)?')],
  ['phone', tok('phone(?:_?number)?|mobile(?:_?number)?|telephone')],
  ['name', tok('first_?name|last_?name|full_?name|sur_?name|given_?name|family_?name')],
  ['birth', tok('date_?of_?birth|birth_?date|birthday|dob')],
  ['address', tok('street(?:_?address)?|home_?address|postal_?code|post_?code|zip_?code|postcode')],
  ['ip', tok('ip_?address')],
  ['gender', tok('gender')],
];
const SENSITIVE: RegExp = tok(
  'ssn|social_?security(?:_?number)?|national_?id|national_?insurance|passport(?:_?number)?|tax_?id|taxpayer(?:_?id)?|driver_?s?_?licen[cs]e|credit_?card|card_?number|cvv|cvc|iban|bank_?account|routing_?number|diagnosis|patient(?:_?id)?|health_?record|medical_?record|prescription|biometric|ethnicity|religion|sexual_?orientation',
);

/** Files whose content states what data the system holds. */
const SCHEMA_PATH =
  /(?:^|\/)(?:migrations?|migrate|schemas?|models?|entities|entity|prisma|db|database|graphql|protos?|openapi|swagger)(?:\/|$)|\.(?:sql|prisma|graphql|gql|proto)$|(?:^|\/)(?:schema|models?|entities)\.(?:py|rb|ts|js|go|java|kt|rs|cs|php)$|[._-](?:model|entity|schema|dto)\.(?:ts|js|py|rb|java|kt|go|cs|php)$|(?:^|\/)(?:openapi|swagger)[^/]*\.(?:ya?ml|json)$/i;
const SCHEMA_EXT =
  /\.(?:sql|prisma|graphql|gql|proto|py|rb|ts|js|go|java|kt|rs|cs|php|ya?ml|json|xml)$/;

function* lines(text: string): Generator<[number, string]> {
  let n = 0;
  for (const l of text.split(/\r?\n/)) yield [++n, l];
}

type Signal = {
  id: string;
  criterion: 'data_class' | 'exposure' | 'blast_radius';
  floor: 'T1' | 'T2';
};
const SIGNALS: Record<string, Signal> = {
  'dc.pii': { id: 'dc.pii', criterion: 'data_class', floor: 'T1' },
  'dc.sensitive_pii': { id: 'dc.sensitive_pii', criterion: 'data_class', floor: 'T2' },
  'ex.routing': { id: 'ex.routing', criterion: 'exposure', floor: 'T1' },
  'ex.open': { id: 'ex.open', criterion: 'exposure', floor: 'T2' },
  'br.migration': { id: 'br.migration', criterion: 'blast_radius', floor: 'T1' },
  'br.iac': { id: 'br.iac', criterion: 'blast_radius', floor: 'T1' },
  'br.prod_inventory': { id: 'br.prod_inventory', criterion: 'blast_radius', floor: 'T2' },
};

function signalFact(
  detector: DetectorId,
  id: keyof typeof SIGNALS,
  evidence: DetectorEvidence[],
): Fact {
  const s = SIGNALS[id] as Signal;
  return {
    kind: 'tier_signal',
    detector,
    signal: s.id,
    criterion: s.criterion,
    floor: s.floor,
    evidence: evidence.slice(0, MAX_EVIDENCE),
  };
}

// ---------------------------------------------------------------- data_class

export function dataClassDetector(): Detector {
  return {
    info: { id: 'tier_data_class', version: '1', criteria: ['RS-ID-3'] },
    async run(reader: TreeReader) {
      const c = new Collector('tier_data_class', reader);
      const candidates = reader.files.filter(
        (f) => isOwnSource(f.path) && SCHEMA_EXT.test(f.path) && SCHEMA_PATH.test(f.path),
      );
      const kinds = new Map<string, DetectorEvidence>();
      const sensitive: DetectorEvidence[] = [];
      let reads = 0;
      for (const f of candidates) {
        if (reads >= MAX_READS) {
          c.capped('schema-like files', MAX_READS);
          break;
        }
        reads++;
        const t = await c.text(f.path, READ_LIMIT);
        if (!t) continue;
        for (const [n, raw] of lines(t.text)) {
          const l = camelToSnake(raw);
          for (const [kind, re] of PII)
            if (!kinds.has(kind) && re.test(l)) kinds.set(kind, c.evidence(t.file, n));
          if (sensitive.length < MAX_EVIDENCE && SENSITIVE.test(l))
            sensitive.push(c.evidence(t.file, n));
        }
      }
      if (kinds.size >= 2) c.add(signalFact('tier_data_class', 'dc.pii', [...kinds.values()]));
      if (sensitive.length > 0) c.add(signalFact('tier_data_class', 'dc.sensitive_pii', sensitive));
      return c.output();
    },
  };
}

// ---------------------------------------------------------------- exposure

const ROUTING_NAME =
  /(?:^|\/)(?:nginx[\w.-]*\.conf|Caddyfile|haproxy\.cfg|traefik[\w.-]*\.(?:ya?ml|toml)|envoy[\w.-]*\.ya?ml|\.htaccess|httpd[\w.-]*\.conf|apache[\w.-]*\.conf|ingress[\w.-]*\.ya?ml|gateway[\w.-]*\.ya?ml|vercel\.json|netlify\.toml|firebase\.json)$/;
const ROUTING_TEXT: RegExp[] = [
  /^\s*kind:\s*(?:Ingress|IngressRoute|Gateway|HTTPRoute|VirtualService)\b/m,
  /\bresource\s+"(?:aws_api_gateway\w*|aws_apigatewayv2\w*|aws_lb|aws_alb|aws_cloudfront_distribution|aws_route53_record|google_compute_url_map|google_compute_global_forwarding_rule|azurerm_application_gateway|azurerm_frontdoor\w*|cloudflare_record)"/,
  /\bAWS::(?:ApiGateway|ApiGatewayV2|ElasticLoadBalancingV2|CloudFront)::/,
  /^\s*\[\[(?:redirects|headers)\]\]/m,
];
const CONFIG_EXT =
  /\.(?:ya?ml|json|toml|conf|cfg|tf|tf\.json|hcl|bicep|template)$|(?:^|\/)(?:Caddyfile|\.htaccess)$/;
const OPEN_TEXT: Array<[RegExp, string]> = [
  [/Access-Control-Allow-Origin['"]?\s*[:,=]?\s*['"]?\*/i, 'cors wildcard'],
  [/\bcors\(\s*\)/, 'cors default (any origin)'],
  [/\borigin\s*:\s*(?:['"]\*['"]|true\b)/, 'cors origin any'],
  [/\ballow_origins\s*=\s*\[\s*['"]\*['"]/i, 'cors allow_origins *'],
  [/\bCORS_(?:ORIGIN_)?ALLOW_ALL(?:_ORIGINS)?\s*=\s*True\b/, 'django cors all'],
  [/\ballowed_?origins?['"]?\s*[:=]\s*\[?\s*['"]\*['"]/i, 'cors allowed origins *'],
  [/^\s*type:\s*LoadBalancer\b/m, 'k8s LoadBalancer service'],
  [/\binternal\s*=\s*false\b/, 'public load balancer'],
  [/\binternet-facing\b/, 'internet-facing load balancer'],
  [/\bpublicly_accessible\s*=\s*true\b/, 'public database'],
  [/\bacl\s*=\s*"public-read(?:-write)?"/, 'public bucket'],
  [/\bblock_public_(?:acls|policy)\s*=\s*false\b/, 'public bucket'],
  [/\bassociate_public_ip_address\s*=\s*true\b/, 'public ip'],
  [/\bmap_public_ip_on_launch\s*=\s*true\b/, 'public ip'],
  [/\ballUsers\b|\ballAuthenticatedUsers\b/, 'public iam'],
  [/--allow-unauthenticated\b/, 'unauthenticated endpoint'],
  [
    /\bauthorization(?:_type)?\s*=\s*"NONE"|\bauthorization_type\s*=\s*"NONE"|\bauth_type\s*=\s*"NONE"/,
    'unauthenticated endpoint',
  ],
];
const OPEN_SOURCE_EXT = /\.(?:js|jsx|ts|tsx|mjs|cjs|py|go|java|kt|rb|php|cs|rs)$/;

export function exposureDetector(): Detector {
  return {
    info: { id: 'tier_exposure', version: '1', criteria: ['RS-ID-3'] },
    async run(reader: TreeReader) {
      const c = new Collector('tier_exposure', reader);
      const routing: DetectorEvidence[] = [];
      const open: DetectorEvidence[] = [];
      const files = reader.files.filter((f) => isOwnSource(f.path));
      const config = files.filter((f) => CONFIG_EXT.test(f.path) || ROUTING_NAME.test(f.path));
      const source = files.filter((f) => OPEN_SOURCE_EXT.test(f.path));
      let reads = 0;
      let capped = false;
      for (const f of [...config, ...source]) {
        if (routing.length >= MAX_EVIDENCE && open.length >= MAX_EVIDENCE) break;
        if (reads >= MAX_READS * 2) {
          capped = true;
          break;
        }
        reads++;
        if (ROUTING_NAME.test(f.path) && routing.length < MAX_EVIDENCE) routing.push(c.evidence(f));
        const t = await c.text(f.path, READ_LIMIT);
        if (!t) continue;
        const isConfig = !OPEN_SOURCE_EXT.test(f.path);
        const hasIngress = /\bingress\b/i.test(t.text);
        for (const [n, l] of lines(t.text)) {
          if (
            isConfig &&
            routing.length < MAX_EVIDENCE &&
            (ROUTING_TEXT.some((re) => re.test(l)) ||
              (/(?:^|\/)serverless\.ya?ml$/.test(f.path) &&
                /^\s*-?\s*(?:http|httpApi)\s*:/.test(l)))
          )
            routing.push(c.evidence(t.file, n));
          if (open.length < MAX_EVIDENCE) {
            if (OPEN_TEXT.some(([re]) => re.test(l))) open.push(c.evidence(t.file, n));
            else if (isConfig && hasIngress && /0\.0\.0\.0\/0|::\/0/.test(l))
              open.push(c.evidence(t.file, n));
          }
        }
      }
      if (capped) c.capped('config and source files', MAX_READS * 2);
      if (routing.length > 0) c.add(signalFact('tier_exposure', 'ex.routing', routing));
      if (open.length > 0) c.add(signalFact('tier_exposure', 'ex.open', open));
      return c.output();
    },
  };
}

// ---------------------------------------------------------------- blast radius

const MIGRATION_PATH =
  /(?:^|\/)(?:migrations?|migrate|alembic\/versions|db\/migrate|prisma\/migrations|flyway|liquibase)\/[^/]+$|(?:^|\/)V\d+(?:_\d+)*__[\w-]+\.sql$|\.migration\.(?:ts|js|py|rb)$/;
const IAC_PATH =
  /\.(?:tf|tfvars|bicep)$|\.tf\.json$|(?:^|\/)(?:terragrunt\.hcl|Pulumi(?:\.[\w-]+)?\.ya?ml|cdk\.json|Chart\.ya?ml|kustomization\.ya?ml|serverless\.ya?ml|samconfig\.toml|ansible\.cfg|playbook[\w-]*\.ya?ml|main\.tf)$|(?:^|\/)cloudformation\/|\.cfn\.(?:ya?ml|json)$/;
const K8S_PATH =
  /(?:^|\/)(?:k8s|kubernetes|manifests|deploy|deployment|helm|charts|kustomize|overlays)\/.+\.ya?ml$/;
const CFN_FILE = /(?:^|\/)(?:template|[\w-]*stack)\.(?:ya?ml|json)$/;
const PROD_INVENTORY =
  /(?:^|\/)(?:inventor(?:y|ies)|overlays|stacks?)\/(?:[^/]*[/_.-])?(?:prod|production|prd)(?:[/_.-][^/]*)?$|(?:^|\/)(?:environments?|envs?)\/(?:[^/]*[/_.-])?(?:prod|production|prd)\.(?:tfvars|ya?ml|json|ini|hcl)$|(?:^|\/)(?:environments?|envs?)\/(?:prod|production|prd)\/.+\.(?:tf|tfvars|ya?ml|hcl)$|(?:^|\/)(?:prod|production|prd)\.(?:tfvars|ya?ml|json|ini|hcl)$|(?:^|\/)values-(?:prod|production|prd)\.ya?ml$|\.(?:prod|production)\.tfvars$/;

export function blastRadiusDetector(): Detector {
  return {
    info: { id: 'tier_blast_radius', version: '1', criteria: ['RS-ID-3'] },
    async run(reader: TreeReader) {
      const c = new Collector('tier_blast_radius', reader);
      const migration: DetectorEvidence[] = [];
      const iac: DetectorEvidence[] = [];
      const prod: DetectorEvidence[] = [];
      let cfnReads = 0;
      for (const f of reader.files) {
        if (isVendored(f.path) || basename(f.path) === '') continue;
        if (
          migration.length < MAX_EVIDENCE &&
          MIGRATION_PATH.test(f.path) &&
          !/(?:^|\/)(?:tests?|__tests__|fixtures?)\//.test(f.path)
        )
          migration.push(c.evidence(f));
        if (
          iac.length < MAX_EVIDENCE &&
          isOwnSource(f.path) &&
          (IAC_PATH.test(f.path) || K8S_PATH.test(f.path))
        )
          iac.push(c.evidence(f));
        else if (
          iac.length < MAX_EVIDENCE &&
          isOwnSource(f.path) &&
          CFN_FILE.test(f.path) &&
          cfnReads < 50
        ) {
          cfnReads++;
          const t = await c.text(f.path, READ_LIMIT);
          if (t && /AWSTemplateFormatVersion|AWS::Serverless-/.test(t.text))
            iac.push(c.evidence(t.file, 1));
        }
        if (prod.length < MAX_EVIDENCE && isOwnSource(f.path) && PROD_INVENTORY.test(f.path))
          prod.push(c.evidence(f));
      }
      if (migration.length > 0) c.add(signalFact('tier_blast_radius', 'br.migration', migration));
      if (iac.length > 0) c.add(signalFact('tier_blast_radius', 'br.iac', iac));
      if (prod.length > 0) c.add(signalFact('tier_blast_radius', 'br.prod_inventory', prod));
      return c.output();
    },
  };
}

// ---------------------------------------------------------------- the floor

const RANK = { T0: 0, T1: 1, T2: 2 } as const;

/**
 * The floor is the highest signal's, T0 when none fired (raise-only afterwards). An unattested T0 is
 * represented, never defaulted: `blocks_m4_until_attested` is true whenever the owner has not
 * attested, which at detection time is always (attestations arrive on card 1), and the reasons say
 * which: regulatory and criticality are never inferred, and a T0 floor needs the positive
 * "no prod, no real data, no dependants" attestation (R-SEC-T3, DEC-4).
 */
export function deriveTier(facts: readonly Fact[]): TierAssessment {
  let floor: keyof typeof RANK = 'T0';
  const signals = new Set<string>();
  for (const f of facts) {
    if (f.kind !== 'tier_signal') continue;
    signals.add(f.signal);
    if (RANK[f.floor] > RANK[floor]) floor = f.floor;
  }
  return {
    floor,
    signals: [...signals].sort(),
    attestation: {
      regulatory: 'unattested',
      criticality: 'unattested',
      t0_positive: floor === 'T0' ? 'unattested' : 'not_applicable',
    },
    blocks_m4_until_attested: true,
    blocks_m4_reasons: [
      ...(floor === 'T0' ? (['t0_unattested'] as const) : []),
      'regulatory_unattested',
      'criticality_unattested',
    ],
  };
}
