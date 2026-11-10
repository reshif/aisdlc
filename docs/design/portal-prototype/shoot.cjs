const { chromium } = require('playwright');
const [,, file, out, ...routes] = process.argv;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: +(process.env.W || 1440), height: +(process.env.H || 900) } });
  if (process.env.AS) await p.addInitScript((pid) => { try { localStorage.setItem('aisdlc.session', JSON.stringify(pid === 'out' ? { pid: null, signedIn: false } : { pid, signedIn: true, at: Date.now(), mfa: true, stepUpUntil: 0, sid: 'ses_web_test' })); } catch {} }, process.env.AS);
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/fonts|ERR_/.test(m.text())) errs.push(m.text()); });
  for (const r of routes) {
    await p.goto('file://' + file + '#' + r);
    await p.waitForTimeout(+(process.env.WAIT || 400));
    const ov = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    await p.screenshot({ path: `${out}/${process.env.AS ? process.env.AS + '-' : ''}${r}.png`, fullPage: process.env.FULL === '1' });
    console.log(r, ov ? 'OVERFLOW-X' : 'ok');
  }
  console.log(errs.join('\n') || 'no errors');
  await b.close();
})();
