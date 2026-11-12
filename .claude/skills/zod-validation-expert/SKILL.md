---
name: zod-validation-expert
description: 'Zod 4 schema validation in AISDLC: defining schemas once in @aisdlc/contracts, type inference, safeParse, refinements, transformations, error formatting and JSON Schema export for portal forms. Use when adding or changing a contract schema, validating input at a service boundary, or wiring a portal form to a contract.'
metadata:
  risk: safe
  source: community
  date_added: '2026-03-05'
---

> Vendored from davila7/claude-code-templates@82b59de, path
> `cli-tool/components/skills/web-development/zod-validation-expert/SKILL.md`, adapted for AISDLC on
> 2026-11-12; AGENTS.md wins on any conflict. See `.claude/THIRD_PARTY.md`.

# Zod Validation Expert

You help write type-safe Zod schemas and validation logic for this repository. The repo pins
`zod` at `4.6.7` (exactly, in every package that uses it); every example below is Zod 4 syntax.

## The rules of this repo come first

- **Contracts are the single vocabulary.** Every entity, enum, event and gate kind is a Zod schema
  defined ONCE in `packages/contracts` and imported everywhere else. Never re-declare an enum or an
  entity in a service, a test or the web app; import it from `@aisdlc/contracts`.
- The contracts pattern is: `export const Tier = z.enum([...])`, `export type Tier = z.infer<typeof Tier>`,
  and for enums a `TierValues` array taken from `Tier.options`. Use the `...Values` arrays for
  selects and checkboxes; never type the members out again.
- **Portal forms are generated from contract schemas.** A card sends its decision form as JSON Schema
  (`z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' })`, see
  `packages/contracts/src/json-schema.ts`), the web app checks it early with
  `services/web/src/lib/schema.ts`, and the server validates the same content again with the same
  contract. The browser is never the authority.
- **Fail closed.** A parse failure is a refusal, never a default that lets the request through.
- **No new dependencies** (no `react-hook-form`, `@hookform/resolvers`, `tRPC`, ...) unless a reviewed
  change adds them with an exact pinned version.
- TypeScript is strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); no `any` and no
  `z.any()` without a comment saying why. Prefer `z.unknown()` and narrow.

## When to use this skill

- Adding or changing a schema in `packages/contracts` (and regenerating its JSON Schema with
  `npm run gen -w @aisdlc/contracts`)
- Validating request bodies, query strings or config at a service boundary
- Inferring TypeScript types from a contract instead of writing interfaces by hand
- Cross-field rules (`.refine`, `.superRefine`) and transformations (`.transform`)
- Turning a `ZodError` into field-level messages for an API response or the portal

## Core idea

Zod removes the duplication of a TypeScript type _and_ a runtime check: define the schema once and
infer the type. Zod **parses**: `parse`/`safeParse` return clean typed data and, for `z.object`,
strip unknown keys. The contracts mostly use `z.strictObject`, which **rejects** unknown keys instead;
keep that for anything that crosses a trust boundary.

## Schema definition and inference

### Primitives, formats and coercion

```typescript
import { z } from 'zod';

const name = z.string().min(3).max(255);
const count = z.number().int().nonnegative();
const at = z.iso.datetime(); // ISO 8601 string, not a Date object

// Zod 4 top-level formats (the method forms like z.string().email() are deprecated)
const email = z.email();
const id = z.uuid();
const link = z.url();

// Coercion: only for inputs that are always strings (URL query parameters, env)
const limit = z.coerce.number().int().min(1).max(100); // "20" -> 20
```

### Objects and type inference

```typescript
import { z } from 'zod';
import { Tier } from '@aisdlc/contracts'; // an enum comes from contracts, never re-listed

export const ExampleRequest = z.strictObject({
  project_id: z.uuid(),
  title: z.string().min(3).max(200),
  tier: Tier,
  note: z.string().max(2000).optional(), // with exactOptionalPropertyTypes: absent, not undefined
  reviewer: z.string().nullable(),
  labels: z.array(z.string()).min(1),
});

export type ExampleRequest = z.infer<typeof ExampleRequest>;
```

With `exactOptionalPropertyTypes`, an optional key means the key may be absent; passing
`{ note: undefined }` is a type error. Build objects conditionally
(`...(note === undefined ? {} : { note })`) rather than widening the schema.

### Advanced types

```typescript
const headers = z.record(z.string(), z.string()); // Record<string, string>

const idOrIndex = z.union([z.string(), z.number()]); // string | number

// Discriminated unions: type-safe switches. Payload fields are explicit or z.unknown(), never z.any().
const Action = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('create'), id: z.string() }),
  z.strictObject({ type: z.literal('update'), id: z.string(), data: z.unknown() }),
  z.strictObject({ type: z.literal('delete'), id: z.string() }),
]);
```

## Parsing and validation

### parse vs safeParse

```typescript
const schema = z.email();

// parse throws a ZodError; use it only where a throw is the refusal you want
try {
  schema.parse('invalid-email');
} catch (err) {
  if (err instanceof z.ZodError) console.error(err.issues);
}

// safeParse returns a result object and narrows by `success`
const result = schema.safeParse('user@example.invalid');
if (!result.success) {
  // refuse: map to the repo's Result / tagged error, never fall through
} else {
  const valid: string = result.data;
}
```

In this repo a failed parse becomes a tagged error or a `Result` failure (see `@aisdlc/kernel`),
and the response names field paths, never the rejected values.

## Customizing validation

### Error messages

```typescript
// Zod 4: the `error` parameter replaces `message`
const reason = z
  .string()
  .min(10, { error: 'A reason needs at least 10 characters' })
  .max(2000, { error: 'The reason is too long' });

// Global customization (z.setErrorMap and ZodIssueCode are Zod 3 APIs)
z.config({
  customError: (issue) => {
    if (issue.code === 'invalid_type' && issue.expected === 'string')
      return 'This field must be text';
    return undefined; // fall back to the default message
  },
});
```

Prefer per-schema messages over a global map: contracts are shared by every service.

### Refinements

```typescript
const WaiverForm = z
  .strictObject({
    starts: z.iso.date(),
    ends: z.iso.date(),
  })
  .refine((v) => v.ends > v.starts, {
    error: 'The waiver must end after it starts',
    path: ['ends'], // attach the issue to the field, not the object
  });
```

### Transformations

```typescript
const integerText = z
  .string()
  .transform((v) => Number.parseInt(v, 10))
  .refine((n) => Number.isInteger(n), { error: 'Not a valid integer' });

type Parsed = z.infer<typeof integerText>; // number (the output type)
```

Note that JSON Schema export (`io: 'output'`) describes the output; a transform cannot be expressed
in JSON Schema, so keep transforms out of schemas the portal receives as forms.

## Integration patterns in this repo

### Portal forms (services/web)

The web app does not run Zod against form input. It receives the JSON Schema of the contract with the
card (`decision_schema`) and checks it with `lib/schema.ts`, which exists because common JSON Schema
validators compile with `new Function`, which the portal's content security policy forbids. To add a
field to a form: change the contract, regenerate, and let both sides follow. Use the contract's
`...Values` arrays and exported constants (for example `TierValues`, `MAX_WAIVER_DAYS`) for options and
limits in the UI.

### Service boundaries (bff, core, other services)

Validate every request body and query against the contract schema before acting, and return field
paths on failure:

```typescript
const parsed = ExampleRequest.safeParse(body);
if (!parsed.success) {
  // z.flattenError / z.treeifyError replace Zod 3's .flatten() / .format()
  const fields = Object.keys(z.flattenError(parsed.error).fieldErrors);
  return refuse(400, 'invalid_request', fields); // field names only, never values
}
```

### Configuration

```typescript
const Env = z.strictObject({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().int().default(8080),
  // Secrets are `file:` references, never the secret itself in the environment
  KEY_REF: z.string().startsWith('file:'),
});

const env = Env.parse(process.env); // fails fast at start-up
```

`z.strictObject` would reject the rest of `process.env`; in practice pick the keys first, or use
`z.object` here, which strips them.

## Best practices

- Do: put shared schemas in `packages/contracts` and import them; co-locate only schemas that are
  private to one module and name no shared vocabulary.
- Do: use `z.infer<typeof Schema>` instead of hand-written interfaces.
- Do: prefer `safeParse` and map the failure to a refusal.
- Do: use `z.coerce` only for always-string inputs. `z.coerce.boolean()` turns `"false"` into `true`;
  use `z.stringbool()` for boolean text.
- Do: use `z.flattenError` / `z.treeifyError` for serializable errors, and return paths, not values.
- Do: run `npm run gen -w @aisdlc/contracts` after changing a contract so the committed JSON Schema
  follows.
- Don't: rely on `.partial()` for update schemas when constraints differ; define a distinct schema.
- Don't: forget `path` in object-level `.refine()` / `.superRefine()`.
- Don't: use `z.any()`; use `z.unknown()` and narrow.

## Troubleshooting

**Problem:** `Type instantiation is excessively deep and possibly infinite.`
**Solution:** Recursive schemas: in Zod 4 use a getter (`get children() { return z.array(Node); }`)
or `z.lazy(() => Node)`, and declare the TypeScript type explicitly.

**Problem:** Empty strings pass with `.optional()`.
**Solution:** `.optional()` allows absence, not `""`. Add `.min(1)`, or preprocess `""` to absent
deliberately.
