/* Floor (per project, live) and Fleet (every project as one row). */
(function () {
  const D = A.data;
  const W = 1500, H = 1010;
  const BT = 175, BB = 721, VX = 1452, Y1 = 312, Y2 = 578;

  /* ---------------------------------------------------------------- geometry */
  const N = {
    S1: { x: 50, y: 82, w: 214, h: 186 }, S2: { x: 339, y: 82, w: 214, h: 186 }, S3: { x: 628, y: 82, w: 214, h: 186 },
    S4: { x: 917, y: 82, w: 214, h: 186 }, S5: { x: 1206, y: 82, w: 214, h: 186 },
    S9: { x: 50, y: 615, w: 188, h: 212 }, S8: { x: 318, y: 615, w: 200, h: 212 }, S7: { x: 598, y: 615, w: 186, h: 212 },
    S6: { x: 866, y: 615, w: 560, h: 212 },
    BIN: { x: 50, y: 352, w: 214, h: 196 }, HOLD: { x: 304, y: 352, w: 241, h: 196 }, QUAR: { x: 585, y: 352, w: 241, h: 196 },
    DESK: { x: 866, y: 352, w: 294, h: 196 }, SCHED: { x: 1200, y: 352, w: 214, h: 196 },
    DONE: { x: 50, y: 905, w: 1376, h: 92 },
  };
  const G = {
    G0G1: { x: 301.5, y: BT, label: 'G0+G1' }, G1f: { x: 590.5, y: BT, label: 'G1f' }, G2: { x: 879.5, y: BT, label: 'G2' },
    G3d: { x: 1168.5, y: BT, label: 'G3d' }, G3: { x: VX, y: 440, label: 'G3', side: true },
    G4: { x: 558, y: BB, label: 'G4', sub: 'PR' }, G5: { x: 278, y: BB, label: 'G5', sub: 'off' }, G6: { x: 144, y: 868, label: 'G6', g6: true },
  };
  const ROOMS = {
    BIN: ['Declined, abandoned', 'closed with a cause code', 'room'],
    HOLD: ['Holding shelf', 'waiting, held, not onboarded', 'room'],
    QUAR: ['Quarantine', 'security triage first', 'room quar'],
    DESK: ['Handoff desk (E4)', 'the owner of record chooses', 'room desk'],
    SCHED: ['Scheduler', 'lease, pod and envelope', 'room'],
  };
  const PODS = [0, 1, 2].map((i) => ({ x: 880 + i * 180.7, y: 693, w: 170.7, h: 120 }));
  const band = (y) => (y < 300 ? 'top' : y < 600 ? 'mid' : y < 880 ? 'bot' : 'done');

  /* ---------------------------------------------------------------- lane routes (from the catalogue) */
  const ROUTE = {
    L0: ['S1', 'S6', 'S7', 'S8', 'S9'],
    L1: ['S1', 'S3', 'S5', 'S6', 'S7', 'S8', 'S9'], L2: ['S1', 'S3', 'S5', 'S6', 'S7', 'S8', 'S9'], L3: ['S1', 'S3', 'S5', 'S6', 'S7', 'S8', 'S9'],
    L4: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'], L5: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'],
    L6: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'], L7: ['S1', 'S6', 'S9'], L8: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'],
  };
  const GATE_AFTER = { S1: 'G0G1', S3: 'G2', S4: 'G3d', S5: 'G3', S7: 'G4', S9: 'G6' };
  const APPROVER = { G0G1: 'pm', G1f: 'pm', G2: 'pm', G3d: 'ks', G3: 'rb', G4: 'so', G6: 'ak' };
  const laneSteps = (stage, lane) => {
    let s = D.stepsOf(stage);
    if (stage === 'S2' && lane !== 'L6') s = s.filter((x) => x !== '2.4' && x !== '2.5');
    if (stage === 'S6') s = s.filter((x) => x !== '6.0');
    if (stage === 'S6' && lane === 'L7') s = s.filter((x) => x !== '6.6');
    if (stage === 'S9') s = s.filter((x) => x !== '9.2' && x !== '9.5');
    if (['L1', 'L2', 'L3'].includes(lane) && stage === 'S3') s = ['3.1', '3.2', '3.3', '3.4'];
    if (['L1', 'L2', 'L3'].includes(lane) && stage === 'S5') s = ['5.1', '5.3', '5.5', '5.8'];
    return s;
  };

  /* items that tell a story elsewhere in the portal stay where they are */
  const PINNED = new Set(['W-31', 'W-29', 'W-19', 'W-18', 'W-24', 'W-27', 'W-33', 'W-26', 'W-12', 'W-16', 'W-22', 'W-36', 'W-30']);

  /* ---------------------------------------------------------------- placement */
  function nodeOf(it) {
    if (it.state === 'done') return 'DONE';
    if (it.state === 'declined') return 'BIN';
    if (it.state === 'held') return 'HOLD';
    if (it.state === 'quarantined') return 'QUAR';
    if (it.state === 'handoff') return 'DESK';
    if (it.state === 'scheduled' || it.step === '6.0') return 'SCHED';
    if (it.gate && G[it.gate]) return it.gate;
    if (it.stage === 'S6' && it.pod) return 'POD' + it.pod;
    return it.stage;
  }
  function layout(items) {
    const groups = {};
    items.forEach((it) => { const n = nodeOf(it); (groups[n] = groups[n] || []).push(it); });
    const pos = {};
    Object.entries(groups).forEach(([n, list]) => {
      list.forEach((it, i) => {
        let x, y;
        if (n.startsWith('POD')) { const p = PODS[+n.slice(3) - 1]; x = p.x + 58; y = p.y + 16; }
        else if (G[n]) {
          const g = G[n];
          if (g.side) { x = g.x - 22; y = g.y + 26 + i * 30; }
          else if (g.g6) { x = g.x + 26 + i * 48; y = g.y - 12; }
          else { x = g.x - 22 + (i % 2) * 0 - Math.floor(i / 1) * 0; y = g.y + 24 + i * 30; }
        } else {
          const b = N[n] || N.S1;
          const top = n === 'DONE' ? 44 : n.length > 2 ? 66 : 86;
          const cols = Math.max(1, Math.floor((b.w - 24) / 48));
          x = b.x + 14 + (i % cols) * 48; y = b.y + top + Math.floor(i / cols) * 32;
        }
        pos[it.key] = { x, y, n };
      });
    });
    return pos;
  }
  function waypoints(a, b) {
    if (!a || a.n === b.n) return [];
    const ba = band(a.y), bb = band(b.y);
    if (ba === 'top' && bb === 'top') return [[a.x, BT - 11], [b.x, BT - 11]];
    if (ba === 'bot' && bb === 'bot') return [[a.x, BB - 11], [b.x, BB - 11]];
    if (ba === 'top' && (bb === 'bot' || b.n === 'SCHED')) return [[a.x, BT - 11], [VX - 20, BT - 11], [VX - 20, b.n === 'SCHED' ? Y1 - 11 : BB - 11], [b.x, b.n === 'SCHED' ? Y1 - 11 : BB - 11]];
    if (bb === 'mid' || ba === 'mid') { const y = ba === 'top' || bb === 'top' ? Y1 - 11 : Y2 - 11; return [[a.x, y], [b.x, y]]; }
    if (bb === 'done') return [[a.x, BB - 11], [144 - 20, BB - 11], [144 - 20, 868 - 11]];
    return [];
  }

  /* ---------------------------------------------------------------- agent score chips (DM §5.3 floor overlay) */
  const agentsAt = (stage) => D.AGENTS.filter((a) => a.steps.some((st) => (D.STEPS[st] || [])[0] === stage));
  const scoreChips = (stage) => A.j(agentsAt(stage).sort((a, b) => a.score - b.score).slice(0, 1), (a) => `<span class="fl-score ${a.score < 0.85 ? 'low' : ''}" title="${a.id} ${A.esc(a.name)}: eval score ${a.score.toFixed(2)} (${a.delta >= 0 ? '+' : ''}${a.delta.toFixed(2)} vs baseline)">${a.id} ${a.score.toFixed(2).slice(1)}</span>`);

  /* ---------------------------------------------------------------- controls that reach the floor */
  const FLOOR_CONTROLS = { payments: [{ id: 'c-12', kind: 'hold', lane: 'L5', by: 'rb', until: '18:00', reason: 'payout provider maintenance window' }] };
  const heldLanes = () => (FLOOR_CONTROLS[A.state.project] || []).map((c) => c.lane);

  /* ---------------------------------------------------------------- static drawing */
  const stationHtml = (id) => {
    const b = N[id], st = A.stage(id);
    const pods = id === 'S6' ? A.j(PODS, (p, i) => `<div class="fl-pod" data-pod="${i + 1}" style="left:${p.x - b.x}px;top:${p.y - b.y}px;width:${p.w}px;height:${p.h}px"><span class="fl-bot">${A.glyph('A', 28)}</span><span class="fl-podlbl mono">pod ${i + 1}, free</span></div>`) : '';
    return `<div class="fl-st ${id === 'S6' ? 'fl-s6' : ''}" data-node="${id}" data-station="${id}" role="button" tabindex="0" aria-label="${id} ${st.name}: open station" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px">
      <div class="fl-sthd"><span class="fl-led" data-led="${id}"></span><span class="mono">${id}</span><span class="sp"></span>${scoreChips(id)}<span class="fl-acts" data-acts="${id}">${A.j(st.actors, (k) => `<span class="fl-glyph">${A.glyph(k, 24)}</span>`)}</span></div>
      <div class="fl-stname">${st.name}</div>${pods}</div>`;
  };
  const roomHtml = (id) => { const b = N[id], [t, s, cls] = ROOMS[id]; return `<div class="fl-${cls.replace(' ', ' fl-')}" data-node="${id}" data-room="${id}" role="button" tabindex="0" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px"><div class="fl-rt">${t}</div><div class="fl-rs">${s}</div></div>`; };
  const gateHtml = (id) => { const g = G[id]; return `<div class="fl-gate ${g.side ? 'side' : ''} ${g.g6 ? 'g6' : ''}" data-gate="${id}" style="left:${g.x}px;top:${g.y}px"><span class="fl-glbl mono">${g.label}${g.sub ? ` <small>${g.sub}</small>` : ''}</span><button class="fl-dia" data-gatebtn="${id}" aria-label="${id}: ${A.esc(D.GATES[id].title)}"></button><span class="fl-who mono" data-who="${id}"></span></div>`; };

  function svgStatic() {
    const vDots = [];
    ['S1', 'S2', 'S3', 'S4', 'S5'].forEach((s) => { const b = N[s]; vDots.push([b.x + b.w / 2, b.y + b.h, Y1]); });
    ['BIN', 'HOLD', 'QUAR', 'DESK', 'SCHED'].forEach((s) => { const b = N[s]; const cx = b.x + b.w / 2; vDots.push([cx, Y1, b.y], [cx, b.y + b.h, Y2]); });
    ['S9', 'S8', 'S7'].forEach((s) => { const b = N[s]; vDots.push([b.x + b.w / 2, Y2, b.y]); });
    [N.S6.x + 80, N.S6.x + 300, N.S6.x + 480].forEach((x) => vDots.push([x, Y2, N.S6.y]));
    Object.values(G).filter((g) => !g.side && !g.g6 && g.y === BT).forEach((g) => vDots.push([g.x, BT + 14, Y1]));
    vDots.push([278, Y2, BB - 10], [558, Y2, BB - 10]);
    return `
    <svg class="fl-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      <defs>
        <marker id="ah-o" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--back)"/></marker>
        <marker id="ah-g" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--muted)"/></marker>
      </defs>
      <g class="fl-dots">
        <line x1="30" y1="${Y1}" x2="1480" y2="${Y1}"/><line x1="30" y1="${Y2}" x2="1480" y2="${Y2}"/>
        <line x1="30" y1="${Y1}" x2="30" y2="${Y2}"/><line x1="1480" y1="${Y1 - 140}" x2="1480" y2="${Y2}"/>
        ${A.j(vDots, ([x, a, b]) => `<line x1="${x}" y1="${a}" x2="${x}" y2="${b}"/>`)}
        ${A.j([[30, Y1], [1480, Y1], [30, Y2], [1480, Y2], [1480, Y1 - 140]], ([x, y]) => `<circle cx="${x}" cy="${y}" r="3.2"/>`)}
      </g>
      <text class="fl-tracklbl" x="40" y="${Y1 - 9}">bypass track</text><text class="fl-tracklbl" x="40" y="${Y2 - 9}">bypass track</text>
      <path class="fl-belt" d="M14 ${BT} H${VX} V${BB} H52"/>
      <path class="fl-belt-run" d="M14 ${BT} H${VX} V${BB} H52"/>
      <path class="fl-belt" d="M144 ${N.S9.y + N.S9.h} V${N.DONE.y}" style="stroke-width:14"/>
      <path class="fl-belt-run" d="M144 ${N.S9.y + N.S9.h} V${N.DONE.y}"/>
      <!-- lane shortcuts: grey dashes -->
      <path class="fl-short" d="M${G.G0G1.x - 4} ${BT + 16} V${Y1 - 4} H${N.S3.x + 60} V${N.S3.y + N.S3.h + 2}" marker-end="url(#ah-g)"/>
      <path class="fl-short" d="M${G.G0G1.x + 4} ${BT + 16} V${Y1 + 4} H${VX - 12} V${BB - 16}" marker-end="url(#ah-g)"/>
      <g class="fl-edges"></g>
    </svg>`;
  }
  const tag = (x, y, text, cls = '') => `<div class="fl-tag ${cls}" style="left:${x}px;top:${y}px">${text}</div>`;

  /* static back-edges from the record: the stories behind W-29, W-31, W-24 */
  const STORY_EDGES = [
    { d: `M${N.S6.x + 318} ${N.S6.y} V${Y2} H${N.HOLD.x + 50} V${N.HOLD.y + N.HOLD.h + 4}`, tag: [470, Y2, 'X1 irreversible migration: waiting on a person, pod released'], cls: '' , key: 'W-29' },
    { d: `M${N.HOLD.x + 266} ${N.HOLD.y + 110} V${Y1} H${N.SCHED.x + 96} V${N.SCHED.y - 4}`, tag: [830, Y1, 'X1 approved: re-admit and reload saved work'], cls: 'old', key: 'W-31' },
    { d: `M${G.G4.x + 16} ${BB - 18} V${Y2 + 8} H${N.SCHED.x + 50} V${N.SCHED.y + N.SCHED.h + 4}`, tag: [1000, Y2 + 8, 'B13 merge review asked for changes, round 1 of 2'], cls: 'old', key: 'W-24' },
  ];

  /* ---------------------------------------------------------------- the view */
  let ledgerSeq = 18423;
  let showTags = true, onlyMine = false;
  let timer = null, onResize = null, speed = 1, paused = false, laneFilter = null, log = [], fit = true, nextNum = 41;

  function floorRender() {
    const proj = A.project(A.state.project);
    if (!A.canSeeProject(proj.id)) {
      return A.pageHead({ title: `Floor: ${proj.name}`, sub: 'This project is confidential. The floor shows it collapsed: no item keys, titles or positions.' }) + A.empty(`${A.icon('lock', 20)}<div style="margin-top:8px">2 items in flight · positions hidden (FD-D6). People with <span class="mono">item.view_floor</span> on Identity Hub see the full floor.</div>`);
    }
    const mine = A.myDecisions().filter((i) => i.project === proj.id);
    const first = mine[0];
    const ctl = FLOOR_CONTROLS[proj.id] || [];
    const vl = A.viewLevel(proj.id);
    return `
    <div class="fl-head">
      <div class="fl-ht"><h1 class="fl-title">Floor: ${A.esc(proj.name)}</h1>
        <p class="sub muted">The same requests as the board, moving through stations live. Gates show the initials of the people they are waiting on. Click a chip to open it.</p></div>
      <div class="fl-hr">
        ${first ? `<a class="fl-wait" href="#inbox"><b>Waiting on you:</b> ${A.esc(D.GATES[first.gate]?.title || 'a decision')} for ${first.key}${mine.length > 1 ? ` (and ${mine.length - 1} more in your inbox)` : ''}</a>` : ''}
        ${A.can('kill.request', { type: 'Project', project: proj.id }) ? '<button class="kill-btn" data-go="kill">Kill switch</button>' : ''}
      </div>
    </div>
    ${A.state.killed ? `<div class="banner bad">${A.icon('kill', 16)} <b>Kill active on ${A.esc(proj.name)}.</b> Sessions are stopped and admission is closed; the floor is frozen until two people release it. <span class="sp"></span><a href="#kill">Kill switch</a></div>` : ''}
    ${A.j(ctl, (c) => `<div class="banner warn">${A.icon('controls', 16)} <b>Control ${c.id}: ${c.kind} on lane ${c.lane}</b> until ${c.until} · ${A.esc(c.reason)} · applied by ${A.esc(D.PEOPLE[c.by].name)}. ${c.lane} items stay where they are. <span class="sp"></span><a href="#controls">Controls</a></div>`)}
    ${vl === 1 ? `<div class="banner info">${A.icon('lock', 16)} You see this floor as a viewer: positions, lanes and who it waits on. Titles and content stay hidden (data class D0).</div>` : ''}
    <div class="fl-bar">
      <button class="btn sm" id="fl-play" aria-pressed="${!paused}">${paused ? A.icon('play', 14) + ' Resume' : '<span class="fl-live"></span> Live'}</button>
      <div class="seg" id="fl-speed" role="group" aria-label="Speed">${A.j([1, 2, 4], (s) => `<button data-sp="${s}" aria-pressed="${s === speed}">${s}×</button>`)}</div>
      <div class="fl-lanes" id="fl-lanes">${A.j(D.LANE_GROUPS, ([g, label, c]) => `<button class="fl-lanebtn" data-lg="${g}" aria-pressed="${!laneFilter || laneFilter === g}"><i style="background:${c}"></i>${label}</button>`)}</div>
      <span class="sp"></span>
      <span class="fl-counts small" id="fl-counts"></span>
      <div class="seg" role="group" aria-label="Show"><button id="fl-t-tags" aria-pressed="${showTags}">Tags</button><button id="fl-t-mine" aria-pressed="${onlyMine}">Mine</button></div>
      <div class="seg"><button id="fl-fit" aria-pressed="${fit}">Fit</button><button id="fl-real" aria-pressed="${!fit}">100%</button></div>
    </div>
    <div class="fl-viewport ${showTags ? '' : 'notags'}" id="fl-vp"><div class="fl-tip" id="fl-tip" hidden></div><div class="fl-scale" id="fl-scale"><div class="fl-plan" id="fl-plan">
      ${svgStatic()}
      ${A.j(['S1', 'S2', 'S3', 'S4', 'S5', 'S9', 'S8', 'S7', 'S6'], stationHtml)}
      ${A.j(Object.keys(ROOMS), roomHtml)}
      <div class="fl-done" data-node="DONE" style="left:${N.DONE.x}px;top:${N.DONE.y}px;width:${N.DONE.w}px;height:${N.DONE.h}px"><div class="fl-rt">Done</div></div>
      ${A.j(Object.keys(G), gateHtml)}
      ${tag(450, Y1 - 4, 'L1–3: skips S2', 'short')}
      ${tag(1160, Y1 + 4, 'L0: skips S2, S3, S4, S5', 'short')}
      <div id="fl-tags"></div>
      <div class="fl-chips" id="fl-chips" data-peek-chips></div>
    </div></div></div>
    <div class="fl-legend small">
      <span><i class="lg-belt"></i>Solid grey: the main belt, forward moves</span>
      <span><i class="lg-dot"></i>Dotted: the bypass track, for every move off the belt</span>
      <span style="color:var(--back)"><i class="lg-back"></i>Orange: back-edge</span>
      <span style="color:var(--hand)"><i class="lg-hand"></i>Blue: handoff to a person</span>
      <span style="color:var(--quar)"><i class="lg-quar"></i>Red: quarantine</span>
      <span><i class="lg-short"></i>Grey dashes: lane shortcut</span>
      <span>${A.glyph('A', 16)} agent · ${A.glyph('D', 16)} deterministic · ${A.glyph('H', 16)} person</span>
      <span><span class="fl-score">A7 .90</span> agent eval score</span>
      <span><i class="lg-mine"></i>Gold ring: waiting on you</span>
      <span class="faint">Click a station, gate or room for details; hover a chip to see its route.</span>
    </div>
    <div class="grid fl-below">
      ${A.card('Live activity', `<ol class="fl-log" id="fl-log"></ol>`, { actions: '<span class="pill info">from the record</span>', flush: true })}
      ${A.card('Flow, last 24 hours', flowBlock(), { actions: '<a class="small" href="#board">Open board</a>' })}
      ${A.card('Stations', stationStats(), { flush: true })}
    </div>`;
  }

  function flowBlock() {
    const f = [3, 4, 2, 5, 6, 4, 7, 5, 3, 6, 8, 6, 5, 7, 9, 6, 4, 5, 7, 8, 6, 5, 7, 6];
    const b = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
    return `<div class="stats" style="grid-template-columns:repeat(3,minmax(0,1fr))">
      <div class="stat"><span class="k">Forward</span><span class="v num">${f.reduce((a, c) => a + c)}</span><span class="d">F moves</span></div>
      <div class="stat warn"><span class="k">Back-edges</span><span class="v num">${b.reduce((a, c) => a + c)}</span><span class="d">B9 ×2, B13, X1</span></div>
      <div class="stat"><span class="k">Re-lanes</span><span class="v num">1</span><span class="d">R1 upshift W-25</span></div></div>
      <div style="margin-top:12px">${flowChart(f, b)}</div>
      <div class="small muted" style="margin-top:6px">Hourly FlowWindow counts. Bars: forward moves; orange ticks: back-edges.</div>`;
  }
  function flowChart(f, b) {
    const w = 420, h = 92, max = Math.max(...f), bw = w / f.length;
    return `<div class="tbl-wrap"><svg width="100%" viewBox="0 0 ${w} ${h + 18}" style="max-width:100%;min-width:300px" aria-label="Forward moves per hour">
      ${[0.5, 1].map((t) => `<line x1="0" x2="${w}" y1="${h - h * t * 0.9}" y2="${h - h * t * 0.9}" stroke="var(--line)" stroke-width="1"/><text x="${w}" y="${h - h * t * 0.9 - 3}" text-anchor="end" font-size="9" fill="var(--faint)" font-family="IBM Plex Mono">${Math.round(max * t)}</text>`).join('')}
      ${A.j(f, (v, i) => `<rect x="${i * bw + 1.5}" y="${h - (v / max) * h * 0.9}" width="${bw - 3}" height="${(v / max) * h * 0.9}" rx="1.5" fill="var(--hand)" opacity="${i === f.length - 1 ? 1 : 0.55}"/>${b[i] ? `<rect x="${i * bw + 1.5}" y="${h + 3}" width="${bw - 3}" height="4" fill="var(--back)"/>` : ''}`)}
      <text x="0" y="${h + 17}" font-size="9" fill="var(--faint)" font-family="IBM Plex Mono">−24h</text><text x="${w}" y="${h + 17}" text-anchor="end" font-size="9" fill="var(--faint)" font-family="IBM Plex Mono">now</text></svg></div>`;
  }
  function stationStats() {
    const rows = D.STAGES.map((s) => { const items = A.itemsOf(A.state.project).filter((i) => i.stage === s.id && !['done', 'declined'].includes(i.state)); return { s, n: items.length, wait: items.filter((i) => i.state === 'waiting').length, stuck: items.filter((i) => i.state === 'stuck').length }; });
    return A.table([{ h: 'Station', r: (r) => `<span class="mono faint">${r.s.id}</span> ${r.s.name}` }, { h: 'In', cls: 'r', r: (r) => r.n }, { h: 'Waiting', cls: 'r', r: (r) => r.wait || '<span class="faint">0</span>' }, { h: 'Stuck', cls: 'r', r: (r) => (r.stuck ? `<span class="pill bad">${r.stuck}</span>` : '<span class="faint">0</span>') }], rows);
  }

  /* ---------------------------------------------------------------- live part */
  let lastPos = {};
  function draw(animate) {
    const chipsEl = document.getElementById('fl-chips'); if (!chipsEl) return;
    const items = A.itemsOf(A.state.project);
    const pos = layout(items);
    const seen = new Set();
    items.forEach((it) => {
      const p = pos[it.key]; seen.add(it.key);
      let el = chipsEl.querySelector(`[data-chip="${it.key}"]`);
      const lg = A.laneGroup(it.lane);
      if (!el) {
        const t = document.createElement('div'); t.innerHTML = A.chip(it); el = t.firstElementChild; el.classList.add('fl-chip'); chipsEl.appendChild(el);
        el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
        if (animate) el.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'none' }], { duration: 500 });
      } else {
        const a = lastPos[it.key];
        if (animate && a && (a.x !== p.x || a.y !== p.y)) {
          const pts = [[a.x, a.y], ...waypoints(a, p), [p.x, p.y]];
          let len = 0; const segs = pts.slice(1).map((q, i) => { const d = Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]); len += d; return d; });
          let acc = 0; const frames = pts.map((q, i) => { if (i) acc += segs[i - 1]; return { left: q[0] + 'px', top: q[1] + 'px', offset: len ? acc / len : i / (pts.length - 1) }; });
          el.animate(frames, { duration: Math.min(2600, 500 + len * 1.2) / speed, easing: 'ease-in-out' });
        }
        el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
      }
      el.classList.toggle('stuck', it.state === 'stuck');
      el.classList.toggle('dim', (!!laneFilter && lg !== laneFilter) || (onlyMine && !(it.wait.includes(A.me()) || it.requester === A.me())));
      el.classList.toggle('mine', it.wait.includes(A.me()) && !!it.gate);
      el.classList.toggle('hold', heldLanes().includes(it.lane) && !['done', 'declined'].includes(it.state));
      el.removeAttribute('title');
      el.querySelector('b').style.background = A.laneColor(it.lane);
    });
    chipsEl.querySelectorAll('[data-chip]').forEach((el) => { if (!seen.has(el.dataset.chip)) el.remove(); });
    lastPos = pos;
    // gate initials, station LEDs and bots, pods
    Object.keys(G).forEach((g) => { const who = items.filter((i) => i.gate === g && i.state === 'waiting').flatMap((i) => i.wait); const el = document.querySelector(`[data-who="${g}"]`); if (el) el.textContent = [...new Set(who)].map((w) => D.PEOPLE[w]?.initials || w).join(' '); });
    D.STAGES.forEach((s) => {
      const here = items.filter((i) => i.stage === s.id && !['done', 'declined', 'held', 'quarantined', 'handoff', 'scheduled'].includes(i.state) && !(i.gate && G[i.gate]));
      const led = document.querySelector(`[data-led="${s.id}"]`); if (led) led.className = 'fl-led' + (here.some((i) => i.state === 'stuck') ? ' bad' : here.length ? ' on' : '');
      const acts = document.querySelector(`[data-acts="${s.id}"]`);
      if (acts) acts.classList.toggle('busy', here.some((i) => { const a = (D.STEPS[i.step] || [])[1] || ''; return a.includes('A') && i.state === 'working'; }));
    });
    PODS.forEach((p, i) => {
      const el = document.querySelector(`[data-pod="${i + 1}"]`); if (!el) return;
      const it = items.find((x) => x.pod === i + 1 && x.stage === 'S6' && x.state === 'working');
      el.classList.toggle('busy', !!it);
      el.querySelector('.fl-podlbl').textContent = it ? `pod ${i + 1}, ${it.key} · ${it.step}` : `pod ${i + 1}, free`;
    });
    const c = { working: 0, waiting: 0, held: 0, stuck: 0 };
    items.forEach((i) => { if (c[i.state] != null) c[i.state]++; });
    const ce = document.getElementById('fl-counts'); if (ce) ce.innerHTML = `<span class="pill info">${c.working} working</span> <span class="pill gate">${c.waiting} waiting</span> <span class="pill back">${c.held} held</span> <span class="pill bad">${c.stuck} stuck</span>`;
  }

  function drawStoryEdges() {
    const g = document.querySelector('.fl-edges'); const tags = document.getElementById('fl-tags'); if (!g) return;
    const items = A.itemsOf(A.state.project);
    const live = STORY_EDGES.filter((e) => items.find((i) => i.key === e.key));
    g.innerHTML = A.j(live, (e) => `<path class="fl-back ${e.cls}" d="${e.d}" marker-end="url(#ah-o)"/>`);
    tags.innerHTML = A.j(live, (e) => tag(e.tag[0], e.tag[1], e.tag[2], 'back ' + e.cls));
  }
  function flashEdge(d, text, x, y) {
    const g = document.querySelector('.fl-edges'), tags = document.getElementById('fl-tags'); if (!g) return;
    const ns = 'http://www.w3.org/2000/svg'; const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); p.setAttribute('class', 'fl-back fresh'); p.setAttribute('marker-end', 'url(#ah-o)'); g.appendChild(p);
    const t = document.createElement('div'); t.className = 'fl-tag back fresh'; t.style.left = x + 'px'; t.style.top = y + 'px'; t.textContent = text; tags.appendChild(t);
    setTimeout(() => { p.remove(); t.remove(); }, 7000 / speed + 2000);
  }

  function pushLog(html) {
    const d = new Date(); log.unshift({ t: d.toTimeString().slice(0, 8), html }); log = log.slice(0, 9);
    const el = document.getElementById('fl-log'); if (el) el.innerHTML = A.j(log, (l) => `<li><span class="mono faint">${l.t}</span><span>${l.html}</span></li>`);
  }

  const ref = (it) => `<a href="#item-${it.key}" class="ichip"><b style="background:${A.laneColor(it.lane)}">${it.key}</b></a>`;
  function enterStage(it, stage) {
    it.stage = stage; it.gate = null; it.wait = [];
    if (stage === 'S6') { it.state = 'scheduled'; it.step = '6.0'; it.pod = null; return; }
    it.state = 'working'; it.step = laneSteps(stage, it.lane)[0] || D.stepsOf(stage)[0];
  }
  function nextStage(it) { const r = ROUTE[it.lane]; return r[r.indexOf(it.stage) + 1]; }
  function admit(items) {
    const busy = new Set(items.filter((i) => i.stage === 'S6' && i.pod && i.state === 'working').map((i) => i.pod));
    const free = [1, 2, 3].find((p) => !busy.has(p));
    const q = items.find((i) => i.state === 'scheduled' && !PINNED.has(i.key) && !heldLanes().includes(i.lane));
    if (free && q) { q.state = 'working'; q.pod = free; q.step = laneSteps('S6', q.lane)[0]; pushLog(`${ref(q)} admitted to pod ${free}: lease epoch ${3 + free}, envelope reserved (6.0)`); return true; }
    return false;
  }
  function tick() {
    if (paused || A.state.killed) return;
    const items = A.itemsOf(A.state.project);
    // a new request now and then
    if (Math.random() < 0.07 && A.state.project === 'payments') {
      const lanes = ['L1', 'L2', 'L4', 'L4', 'L0', 'L3', 'L6'];
      const key = `W-${nextNum++}`; const lane = lanes[Math.floor(Math.random() * lanes.length)];
      const titles = ['Validate IBAN checksum on payouts', 'Expose refund fees in the API', 'Rate limit /tokens per merchant', 'Hotfix: webhook retries stuck', 'Add Pix as a payment method', 'Clean up deprecated v1 endpoints', 'Surface 3DS challenge reasons'];
      D.ITEMS.push({ key, lane, stage: 'S1', step: '1.1', state: 'working', title: titles[nextNum % titles.length], project: 'payments', gate: null, wait: [], requester: 'dn', owner: 'pm', risk: 'medium', size: 'M', type: 'change', age: 'now', updated: 'now', units: [0, 1], spend: [0, 4000], backEdges: [] });
      pushLog(`New request ${key} from the portal: normalised and taint-marked (1.1)`);
      draw(true); return;
    }
    if (admit(items)) { draw(true); return; }
    const movers = items.filter((i) => !PINNED.has(i.key) && !heldLanes().includes(i.lane) && !['done', 'declined', 'held', 'quarantined', 'handoff', 'scheduled', 'stuck'].includes(i.state) && !i.wait.includes(D.ME) && !(i.state === 'waiting' && !i.gate));
    if (!movers.length) return;
    const it = movers[Math.floor(Math.random() * movers.length)];
    if (it.gate) {
      const g = it.gate; const who = D.PEOPLE[it.wait[0]] || D.PEOPLE.pm;
      const seq = ledgerSeq++;
      pushLog(`${ref(it)} ${A.gate(g)} approved by ${who.initials}: ledger #${seq.toLocaleString()}`);
      if (g === 'G6') { it.state = 'done'; it.gate = null; it.wait = []; it.step = '9.3'; }
      else enterStage(it, nextStage(it));
      draw(true); return;
    }
    const steps = laneSteps(it.stage, it.lane); const i = steps.indexOf(it.step);
    if (i >= 0 && i < steps.length - 1) {
      it.step = steps[i + 1]; const [, actor, title] = D.STEPS[it.step];
      pushLog(`${ref(it)} ${it.step} ${A.esc(title)} ${A.actors(A.actorKinds(actor), 14)}`);
      const el = document.querySelector(`#fl-chips [data-chip="${it.key}"]`); if (el) el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 500 });
      draw(false); return;
    }
    // end of stage
    if (it.stage === 'S7' && Math.random() < 0.3) {
      it.backEdges = [...(it.backEdges || []), { id: 'B9', note: 'B9 verify failed: back to build', at: 'now' }];
      enterStage(it, 'S6');
      pushLog(`<span style="color:var(--back)">B9</span> ${ref(it)} 7.3 spec conformance failed: back to build, rework 1 of 2`);
      flashEdge(`M${N.S7.x + 93} ${N.S7.y} V${Y2 - 8} H${N.SCHED.x + 150} V${N.SCHED.y + N.SCHED.h + 4}`, `B9 ${it.key}: verify failed, back to build`, 980, Y2 - 8);
      draw(true); return;
    }
    if (it.stage === 'S6') { it.pod = null; }
    const gate = GATE_AFTER[it.stage];
    if (gate && !(gate === 'G2' && !ROUTE[it.lane].includes('S3'))) {
      it.state = 'waiting'; it.gate = gate; it.wait = [gate === 'G6' ? it.requester : APPROVER[gate]];
      pushLog(`${ref(it)} waiting at ${A.gate(gate)} on ${D.PEOPLE[it.wait[0]]?.initials || ''}`);
    } else {
      const ns = nextStage(it);
      if (!ns) { it.state = 'done'; it.step = '9.3'; pushLog(`${ref(it)} closed (9.3): close-out record written`); }
      else { enterStage(it, ns); pushLog(`${ref(it)} → ${ns} ${A.esc(A.stage(ns).name)}${it.lane === 'L0' && ns === 'S6' ? ' (L0 shortcut)' : ''}`); }
    }
    draw(true);
  }

  function fitPlan() {
    const vp = document.getElementById('fl-vp'), sc = document.getElementById('fl-scale'), plan = document.getElementById('fl-plan'); if (!vp) return;
    const s = fit ? Math.min(1.2, vp.clientWidth / W) : 1;
    plan.style.transform = `scale(${s})`; sc.style.width = W * s + 'px'; sc.style.height = H * s + 'px';
    vp.classList.toggle('real', !fit);
  }

  function floorMount(root) {
    if (!document.getElementById('fl-plan')) return;
    fit = window.innerWidth >= 900 ? fit : false;
    fitPlan(); drawStoryEdges(); draw(false);
    if (!log.length) {
      [['W-23', '5.3 Task plan per Unit'], ['W-28', '3.4 Oracle specs'], ['W-37', '7.1 Deterministic checks'], ['W-31', 'u2 self-check: 0 tripwires'], ['W-21', '6.5 Self-check and tripwires']].forEach(([k, t]) => { const it = A.item(k); if (it) pushLog(`${ref(it)} ${t}`); });
    } else pushLog('Floor reopened');
    onResize = () => fitPlan(); window.addEventListener('resize', onResize);
    clearInterval(timer); timer = setInterval(tick, 1700 / speed);
    root.querySelector('#fl-play').onclick = () => { paused = !paused; A.render(); };
    root.querySelectorAll('#fl-speed [data-sp]').forEach((b) => (b.onclick = () => { speed = +b.dataset.sp; root.querySelectorAll('#fl-speed [data-sp]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); clearInterval(timer); timer = setInterval(tick, 1700 / speed); }));
    root.querySelectorAll('#fl-lanes [data-lg]').forEach((b) => (b.onclick = () => { laneFilter = laneFilter === b.dataset.lg ? null : b.dataset.lg; root.querySelectorAll('#fl-lanes [data-lg]').forEach((x) => x.setAttribute('aria-pressed', String(!laneFilter || laneFilter === x.dataset.lg))); draw(false); }));
    root.querySelector('#fl-fit').onclick = () => { fit = true; root.querySelector('#fl-fit').setAttribute('aria-pressed', 'true'); root.querySelector('#fl-real').setAttribute('aria-pressed', 'false'); fitPlan(); };
    root.querySelector('#fl-real').onclick = () => { fit = false; root.querySelector('#fl-fit').setAttribute('aria-pressed', 'false'); root.querySelector('#fl-real').setAttribute('aria-pressed', 'true'); fitPlan(); };
  }
  function floorUnmount() { clearInterval(timer); timer = null; if (onResize) window.removeEventListener('resize', onResize); }


  /* ---------------------------------------------------------------- interaction: tooltip, route highlight, drawers */
  const STAGE_OF_GATE = { G0G1: 'S1', G1f: 'S2', G2: 'S3', G3d: 'S4', G3: 'S5', G4: 'S7', G5: 'S8', G6: 'S9' };
  const whoCan = (slotGate, project) => {
    const slot = A.access.GATE_POLICY[slotGate]?.slot;
    const roles = A.access.ROLES.filter((r) => r.slot === slot).map((r) => r.role_id);
    return [...new Set(A.access.BINDINGS.filter((b) => roles.includes(b.role) && b.scope.kind === 'project' && b.scope.ref === project).map((b) => b.pid))];
  };
  function tipHtml(it) {
    const [, actor, stepTitle] = D.STEPS[it.step] || [];
    const canRead = A.dataClass(it.project) >= 1;
    return `<div class="row" style="gap:6px">${A.lane(it.lane)}<b class="mono">${it.key}</b>${A.statePill(it.state)}</div>
      <div class="fl-tip-t">${canRead ? A.esc(it.title) : '<span class="faint">Title hidden (D0)</span>'}</div>
      <div class="small"><span class="mono">${it.stage} · ${it.step}</span> ${A.esc(stepTitle || '')} ${actor ? A.actors(A.actorKinds(actor), 13) : ''}</div>
      ${it.gate ? `<div class="small">${A.gate(it.gate)} ${A.esc(D.GATES[it.gate]?.title || '')}</div>` : ''}
      ${it.wait.length ? `<div class="small">Waiting on ${A.j(it.wait, (w) => `<b>${A.esc(D.PEOPLE[w]?.name || w)}</b>`)}${it.waitWhat && canRead ? ` · ${A.esc(it.waitWhat)}` : ''}</div>` : ''}
      <div class="tiny faint">route ${A.esc((D.LANES[it.lane] || {}).route || '')} · age ${it.age}</div>`;
  }
  function showRoute(it) {
    const plan = document.getElementById('fl-plan'); if (!plan) return;
    const r = it ? ROUTE[it.lane] : null;
    plan.classList.toggle('routing', !!r);
    plan.querySelectorAll('[data-station]').forEach((el) => el.classList.toggle('onroute', !!r && r.includes(el.dataset.station)));
    plan.querySelectorAll('[data-gate]').forEach((el) => { const st = STAGE_OF_GATE[el.dataset.gate]; el.classList.toggle('onroute', !!r && r.includes(st) && !(el.dataset.gate === 'G2' && !r.includes('S3')) && !(el.dataset.gate === 'G1f' && it.lane !== 'L6') && !(el.dataset.gate === 'G3d' && !r.includes('S4')) && el.dataset.gate !== 'G5'); });
    plan.querySelectorAll('.fl-chip').forEach((el) => el.classList.toggle('focus', !!it && el.dataset.chip === it.key));
  }
  function stationDrawer(id) {
    const st = A.stage(id), items = A.itemsOf(A.state.project).filter((i) => i.stage === id && !['done', 'declined'].includes(i.state));
    const ag = agentsAt(id);
    A.drawer(`<div class="row between"><span class="eyebrow">Station · ${A.esc(A.project(A.state.project).name)}</span><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
      <h2><span class="mono faint">${id}</span> ${st.name}</h2>
      ${A.stats([{ k: 'Here now', v: items.length }, { k: 'Stuck', v: items.filter((i) => i.state === 'stuck').length, tone: items.some((i) => i.state === 'stuck') ? 'bad' : '' }, { k: 'Median time here', v: { S1: '3h', S2: '9h', S3: '7h', S4: '11h', S5: '6h', S6: '2.1h', S7: '38m', S8: '5h', S9: '1d' }[id] || '—' }])}
      ${A.card('Items', items.length ? `<div class="list">${A.j(items, (i) => `<div class="li" data-peek="${i.key}"><span>${A.chip(i)}</span><div><div class="ti">${A.dataClass(i.project) >= 1 ? A.esc(i.title) : '<span class="faint">Title hidden</span>'}</div><div class="me"><span class="mono">${i.step}</span> ${A.esc((D.STEPS[i.step] || [])[2] || '')}${i.wait.length ? ' · waits on ' + i.wait.map((w) => D.PEOPLE[w]?.initials).join(' ') : ''}</div></div>${A.statePill(i.state)}</div>`)}</div>` : '<p class="muted small" style="padding:12px 16px">Nothing here right now.</p>', { flush: true })}
      ${A.card('Steps', A.steps(id, null))}
      ${ag.length ? A.card('Agents at this station', A.j(ag, (a) => `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>${A.glyph('A', 16)} <b>${a.id}</b> ${A.esc(a.name)} <span class="tiny faint mono">${a.ver} · ${a.model}</span></span><span class="fl-score ${a.score < 0.85 ? 'low' : ''}">${a.score.toFixed(2)}</span></div>`) + (A.can('quality.read', { type: 'Fleet' }) ? '<a class="small" href="#evals">Eval board</a>' : '')) : ''}
      <div class="row"><a class="btn" href="#board">Open the board</a></div>`);
  }
  function gateDrawer(g) {
    const proj = A.state.project, gp = A.access.GATE_POLICY[g] || {};
    const items = A.itemsOf(proj).filter((i) => i.gate === g && i.state === 'waiting');
    const people = whoCan(g, proj);
    A.drawer(`<div class="row between"><span class="eyebrow">Gate · ${A.esc(A.project(proj).name)}</span><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
      <h2>${A.gate(g)} ${A.esc(D.GATES[g]?.title || '')}</h2>
      ${A.kv([['Decided by', `<span class="mono">${gp.slot}</span> slot · ${people.length ? A.j(people, (p) => A.who(p)) : '<span class="faint">nobody holds it: the gate cannot be decided (fail closed)</span>'}`], ['Two people', gp.two_person ? 'yes, two different approvers (DEC-28)' : 'no, one approval decides'], ['Own request', gp.own_request === 'allowed' ? 'the requester may decide (acceptance)' : 'blocked: the requester cannot decide it'], ['Step-up', gp.step_up ? 'required' : gp.step_up_if ? `when ${gp.step_up_if}` : 'no'], ['If nobody decides', 'B21 notifies the backup after 1 business day; expiry never approves']])}
      ${A.card(`Waiting here · ${items.length}`, items.length ? `<div class="list">${A.j(items, (i) => { const c = A.decideCheck(g, i.key); return `<div class="li"><span>${A.chip(i)}</span><div><div class="ti">${A.dataClass(i.project) >= 1 ? A.esc(i.title) : '<span class="faint">Title hidden</span>'}</div><div class="me">waits on ${i.wait.map((w) => A.esc(D.PEOPLE[w]?.name || w)).join(', ')} · ${i.updated}</div></div>${c.allow ? `<a class="btn sm primary" href="#gate-${g}-${i.key}">Decide</a>` : `<a class="btn sm" href="#gate-${g}-${i.key}">View</a>`}</div>`; })}</div>` : '<p class="muted small" style="padding:12px 16px">No item waits at this gate.</p>', { flush: true })}`);
  }
  function roomDrawer(id) {
    const [t, sub] = ROOMS[id] || ['Done', ''];
    const st = { BIN: ['declined'], HOLD: ['held'], QUAR: ['quarantined'], DESK: ['handoff'], SCHED: ['scheduled'] }[id] || ['done'];
    const items = A.itemsOf(A.state.project).filter((i) => st.includes(i.state));
    const next = { BIN: 'Closed with a cause code. Reopening is a new request linked to this one.', HOLD: 'Held items keep their saved work; the pod is released. They return when the person decides (X1, X3, E6, G3o).', QUAR: 'Security triage first (SECT). False positive: rebuild cold from 6.1. Confirmed: the branch stays quarantined and the item goes human-led (L8).', DESK: 'The owner of record chooses D1–D5: reshape, extend the envelope (E3), hand to a person, park, or abandon.', SCHED: 'Admission checks H1 approver slot, H2 coding sessions, H3 envelope and WIP; first in, first out.' }[id] || '';
    A.drawer(`<div class="row between"><span class="eyebrow">Room · ${A.esc(A.project(A.state.project).name)}</span><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
      <h2>${t}</h2><p class="muted">${sub}</p><div class="banner info" style="margin:0">${next}</div>
      ${A.card(`Items · ${items.length}`, items.length ? `<div class="list">${A.j(items, (i) => `<div class="li" data-peek="${i.key}"><span>${A.chip(i)}</span><div><div class="ti">${A.dataClass(i.project) >= 1 ? A.esc(i.title) : '<span class="faint">Title hidden</span>'}</div><div class="me">${A.dataClass(i.project) >= 1 ? A.esc(i.waitWhat || i.cause || '') : ''}${i.wait.length ? ' · ' + i.wait.map((w) => D.PEOPLE[w]?.name).join(', ') : ''}</div></div>${i.gate ? A.gate(i.gate) : ''}</div>`)}</div>` : '<p class="muted small" style="padding:12px 16px">Empty.</p>', { flush: true })}`);
  }
  function wireFloor(root) {
    const plan = root.querySelector('#fl-plan'), tip = root.querySelector('#fl-tip'), vp = root.querySelector('#fl-vp');
    if (!plan) return;
    plan.addEventListener('mouseover', (e) => { const c = e.target.closest('.fl-chip'); if (!c) return; const it = A.item(c.dataset.chip); if (!it) return; tip.innerHTML = tipHtml(it); tip.hidden = false; showRoute(it); });
    plan.addEventListener('mousemove', (e) => { if (tip.hidden) return; const r = vp.getBoundingClientRect(); let x = e.clientX - r.left + 16, y = e.clientY - r.top + 16; if (x + 300 > r.width) x = e.clientX - r.left - 316; tip.style.left = Math.max(4, x) + 'px'; tip.style.top = y + 'px'; });
    plan.addEventListener('mouseout', (e) => { const c = e.target.closest('.fl-chip'); if (c && !c.contains(e.relatedTarget)) { tip.hidden = true; showRoute(null); } });
    plan.addEventListener('click', (e) => {
      if (e.target.closest('.fl-chip')) return;
      const g = e.target.closest('[data-gatebtn]'); if (g) return gateDrawer(g.dataset.gatebtn);
      const st = e.target.closest('[data-station]'); if (st) return stationDrawer(st.dataset.station);
      const rm = e.target.closest('[data-room]'); if (rm) return roomDrawer(rm.dataset.room);
      if (e.target.closest('.fl-done')) return roomDrawer('DONE');
    });
    plan.addEventListener('keydown', (e) => { if (e.key !== 'Enter') return; const st = e.target.closest('[data-station]'); if (st) stationDrawer(st.dataset.station); const rm = e.target.closest('[data-room]'); if (rm) roomDrawer(rm.dataset.room); });
    root.querySelector('#fl-t-tags').onclick = (e) => { showTags = !showTags; e.currentTarget.setAttribute('aria-pressed', String(showTags)); vp.classList.toggle('notags', !showTags); };
    root.querySelector('#fl-t-mine').onclick = (e) => { onlyMine = !onlyMine; e.currentTarget.setAttribute('aria-pressed', String(onlyMine)); draw(false); };
  }

  A.view('floor', { label: 'Floor', group: 'Work', icon: 'floor', render: floorRender, mount: (root) => { floorMount(root); wireFloor(root); }, unmount: floorUnmount,
    access: () => ({ action: 'floor.read', res: { type: 'Project', project: A.state.project } }) });

  /* ================================================================ Fleet */
  function fleetRender() {
    const fleetRole = A.bindingsOf(A.me()).some((b) => b.scope.kind === 'fleet');
    const rows = D.PROJECTS.filter((p) => A.canSeeProject(p.id) || (fleetRole && p.classification === 'confidential')).map((p) => {
      const items = A.itemsOf(p.id), live = items.filter((i) => !['done', 'declined'].includes(i.state));
      if (p.classification === 'confidential' && !A.canSeeProject(p.id)) return `<div class="fx-row restricted"><div class="fx-name"><h3>${A.esc(p.name)}</h3><div class="small muted">${A.icon('lock', 12)} confidential · collapsed</div></div><div class="fx-belt fx-hidden">${live.length} items in flight · positions hidden</div><div class="fx-side"></div></div>`;
      if (p.level === 'Onboarding') return `<div class="fx-row"><div class="fx-name"><h3>${A.esc(p.name)}</h3><div class="small muted mono">${p.repo}</div></div><div class="fx-belt fx-hidden">S0 onboarding in progress: Census done, card 4 waiting · <a href="#s0-${p.s0}">open S0</a></div><div class="fx-side">${A.pill('onboarding', 'info')}</div></div>`;
      const cell = (s) => { const n = live.filter((i) => i.stage === s.id && !(i.gate && G[i.gate]) && !['held', 'quarantined', 'handoff', 'scheduled'].includes(i.state)); return `<div class="fx-st ${n.length ? 'on' : ''} ${n.some((i) => i.state === 'stuck') ? 'bad' : ''}" title="${s.id} ${s.name}"><span class="mono">${s.id}</span><b class="num">${n.length || ''}</b>${A.j(n.slice(0, 4), (i) => `<i style="background:${A.laneColor(i.lane)}"></i>`)}</div>`; };
      const gate = (g) => { const n = live.filter((i) => i.gate === g); return `<div class="fx-g ${n.length ? 'on' : ''}" title="${g}">${n.length ? `<b>${n.length}</b>` : ''}</div>`; };
      const room = (lbl, st, cls) => { const n = live.filter((i) => i.state === st).length; return n ? `<span class="pill ${cls}">${n} ${lbl}</span>` : ''; };
      return `<div class="fx-row"><div class="fx-name"><h3><a href="#floor" data-proj="${p.id}">${A.esc(p.name)}</a></h3><div class="small muted mono">${p.repo}</div><div class="row" style="gap:6px;margin-top:4px">${A.pill(p.level, p.level === 'Full' ? 'ok' : p.level === 'Light' ? 'info' : 'mute')}${A.health(p.health)}</div></div>
        <div class="fx-belt">${cell(D.STAGES[0])}${gate('G0G1')}${cell(D.STAGES[1])}${gate('G1f')}${cell(D.STAGES[2])}${gate('G2')}${cell(D.STAGES[3])}${gate('G3d')}${cell(D.STAGES[4])}${gate('G3')}${cell(D.STAGES[5])}${cell(D.STAGES[6])}${gate('G4')}${cell(D.STAGES[7])}${cell(D.STAGES[8])}${gate('G6')}</div>
        <div class="fx-side"><div class="row" style="gap:4px">${room('held', 'held', 'back')}${room('quarantined', 'quarantined', 'bad')}${room('handoff', 'handoff', 'info')}${room('scheduled', 'scheduled', 'mute')}</div><div class="small muted num">${live.length} in flight · ${items.filter((i) => i.state === 'done').length} done (30d)</div>${A.spark([3, 5, 4, 6, 5, 7, 6, 8, 7, 9].map((v) => v + (p.id.length % 3)), { w: 110, h: 22 })}</div></div>`;
    }).join('');
    const all = A.visibleItems().filter((i) => !['done', 'declined'].includes(i.state));
    return A.pageHead({ title: 'Fleet', sub: 'Every project on one screen: where work sits, which gates hold it, and what is held, quarantined or handed off. Open a row for its floor.', actions: '<a class="btn" href="#floor">Open floor</a>' }) +
      A.stats([{ k: 'Items in flight', v: all.length, d: `${D.PROJECTS.length} projects` }, { k: 'Waiting on a person', v: all.filter((i) => i.state === 'waiting').length, d: 'at gates and merges', tone: 'warn' }, { k: 'Coding pods busy', v: '3 / 3', d: 'CODING_SESSION_CAP 3 per factory', tone: 'warn' }, { k: 'Held or quarantined', v: all.filter((i) => ['held', 'quarantined'].includes(i.state)).length, d: 'X1 held, SECT open', tone: 'bad' }, { k: 'Stuck', v: all.filter((i) => i.state === 'stuck').length, d: 'no heartbeat > 30m', tone: 'bad' }]) +
      `<div class="fx-legend small muted"><span>Stations S1–S9 with counts; diamonds are gates with items waiting; coloured ticks are lanes.</span></div><div class="fx-list">${rows}</div>`;
  }
  A.view('fleet', { label: 'Fleet', group: 'Work', icon: 'fleet', render: fleetRender, mount: (root) => root.querySelectorAll('[data-proj]').forEach((a) => a.addEventListener('click', () => { A.state.project = a.dataset.proj; const s = document.getElementById('proj'); if (s) s.value = a.dataset.proj; })) });
})();
