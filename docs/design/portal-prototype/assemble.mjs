// Builds one self-contained HTML page from src/: base.css, core.js, then every view file, then boot.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const dir = new URL('./src/', import.meta.url);
const read = (f) => readFileSync(new URL(f, dir), 'utf8');
const order = ['access.js', 'shell.js', 'floor.js', 'views-work.js', 'views-decide.js', 'views-operate.js', 'views-govern.js', 'views-admin.js'];
const extra = readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'core.js' && !order.includes(f));
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const views = [...order, ...extra].filter((f) => !only || only.includes(f)).filter((f) => { try { readFileSync(new URL(f, dir)); return true; } catch { return false; } });
const css = ['base.css', ...readdirSync(dir).filter((f) => f.endsWith('.css') && f !== 'base.css' && (!only || only.includes(f.replace('.css', '.js'))))].map(read).join('\n');
const out = `<title>AISDLC Portal</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
${css}
</style>
<div id="app"></div>
<script>
${read('core.js')}
${views.map((f) => `/* ---- ${f} ---- */\n${read(f)}`).join('\n')}
A.boot();
</script>
`;
const target = process.argv[2] || new URL('./aisdlc-portal.html', import.meta.url);
writeFileSync(target, out);
console.log('wrote', String(target), out.length, 'bytes;', views.join(', '));
