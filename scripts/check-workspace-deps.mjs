// Fails when a workspace depends on another workspace at a version that workspace does not have.
// npm then resolves the dependency from the public registry instead of linking it, which works on a
// machine with an old node_modules and breaks `npm ci` on a clean one (CI).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const dirs = ['packages', 'services'].flatMap((d) =>
  readdirSync(join(root, d), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, d, e.name, 'package.json')))
    .map((e) => join(root, d, e.name)),
);
const pkgs = dirs.map((d) => ({
  dir: d,
  json: JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')),
}));
const versions = new Map(pkgs.map((p) => [p.json.name, p.json.version]));
const problems = [];
for (const p of pkgs) {
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    for (const [name, spec] of Object.entries(p.json[field] ?? {})) {
      if (!versions.has(name)) continue;
      if (spec !== versions.get(name) && spec !== '*') {
        problems.push(
          `${p.json.name} ${field}: ${name}@${spec}, but the workspace is ${versions.get(name)}`,
        );
      }
    }
  }
}
if (problems.length > 0) {
  console.error(
    `workspace dependency mismatch (npm would fetch these from the registry):\n  ${problems.join('\n  ')}`,
  );
  process.exit(1);
}
console.log(`workspace dependencies ok (${pkgs.length} workspaces)`);
