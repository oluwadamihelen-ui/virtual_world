// Phone apps. Each app asks the game server for data/actions; the server decides everything (limits, ages, money).
import { icon, esc } from './ui.js';

const GRAD = {
  bank: 'linear-gradient(135deg,#1f8a70,#5be0a8)', chat: 'linear-gradient(135deg,#2a6fdb,#6cc4ff)', love: 'linear-gradient(135deg,#d6336c,#ff8fab)',
  odds: 'linear-gradient(135deg,#6d28d9,#c084fc)', jobs: 'linear-gradient(135deg,#0e7490,#67e8f9)', goals: 'linear-gradient(135deg,#d97706,#f4b942)',
  map: 'linear-gradient(135deg,#0d6b78,#4ad0c0)', settings: 'linear-gradient(135deg,#475569,#94a3b8)',
};
const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const ava = (name, size = '') => `<div class="ava" ${size ? `style="width:${size};height:${size};font-size:calc(${size}/2.4);` : 'style="'}background:hsl(${hue(name)} 55% 45%)">${esc((name ?? '?')[0].toUpperCase())}</div>`;
const when = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function phoneApps(ctx) {
  const G = ctx.G, fmt = ctx.fmt, U = ctx.U;
  /** Call a server app action. On failure the player sees a toast and we return null. */
  const call = async (app, a, d) => {
    const r = await ctx.ask({ app, a, d });
    if (!r.ok) { U.toast('error', r.message ?? 'Something went wrong.'); return null; }
    return r.data;
  };
  const cur = () => G().currency;
  const toMvc = (local) => Math.round(Number(local) / cur().perMVC);
  const amountHint = () => `Smallest amount: ${fmt(1)}`;
  const phoneAsk = (tab) => new Promise((resolve) => { G().phoneWait = (m) => { if (m.tab === tab) { G().phoneWait = null; resolve(m.data); } }; ctx.send({ t: 'phone', tab }); });
  const locked = (ph, title) => ph.app(title, `<div class="card2" style="text-align:center"><div style="font-size:34px">🔒</div><b>This app is for players aged 18 and over.</b><p class="hint">Your account's date of birth says you are under 18, or we do not have one. If this is a mistake, please contact support.</p></div>`);
  const adult = () => G().phone?.adult;

  // ------------------------------------------------------------------ Bank ("Vault")
  async function bankApp(ph, tab = 'home') {
    const s = G().summary, c = cur();
    const head = `<div class="card2"><small>Balance</small><div class="bignum">${fmt(s.balance)}</div><small>≈ ${s.balance.toLocaleString('en-US')} MVC · ${esc(c.flag)} ${esc(c.name)}</small></div>
      <div class="seg" id="bkTabs">${[['home', 'Activity'], ['send', 'Send'], ['loan', 'Loan'], ['rates', 'Rates']].map(([k, n]) => `<button data-k="${k}" class="${k === tab ? 'on' : ''}">${n}</button>`).join('')}</div><div id="bkBody"><p>Loading…</p></div>`;
    ph.app('Vault', head, (el) => el.querySelectorAll('#bkTabs button').forEach((b) => b.onclick = () => bankApp(ph, b.dataset.k)));
    const o = await call('bank', 'overview');
    const body = document.getElementById('bkBody'); if (!o || !body) return;
    const bn = document.querySelector('.phone .bignum'); if (bn) bn.textContent = fmt(o.balance);
    if (o.collected) U.toast('info', `${fmt(o.collected)} was collected for your overdue loan.`);
    if (tab === 'rates') {
      body.innerHTML = `<div class="card2"><b>Exchange rates</b><small style="display:block;margin:2px 0 8px;opacity:.8">Fixed game rates. Your wallet shows the currency of the country you are in.</small><div class="list">${ctx.S.geo.countries.map((k) => `<div class="li"><span>${k.flag} ${esc(k.currency)}</span><b>1 MVC = ${esc(ctx.S.geo.currencies[k.currency].symbol)}${ctx.S.geo.currencies[k.currency].perMVC}</b></div>`).join('')}</div></div>`;
    } else if (tab === 'send') {
      body.innerHTML = `<div class="card2 field"><label>Send to (player name)</label><input id="sTo" maxlength="60" placeholder="Exact player name" autocomplete="off">
        <label>Amount (${esc(c.symbol)})</label><input id="sAmt" type="number" min="1" inputmode="decimal" placeholder="0"><div class="hint" id="sMvc">${amountHint()}</div>
        <label>Note (optional)</label><input id="sNote" maxlength="60"><button class="btn mint" id="sGo">Send money</button>
        <div class="hint">Limit today: ${fmt(o.sentToday)} of ${fmt(o.dayCap)} sent. Max per transfer ${fmt(o.maxPerTransfer)}. You can only pay players in your own age group.</div></div>`;
      const amt = document.getElementById('sAmt'); amt.oninput = () => { document.getElementById('sMvc').textContent = `= ${toMvc(amt.value).toLocaleString('en-US')} MVC`; };
      let busy = false, k = newKey();
      document.getElementById('sGo').onclick = async () => {
        if (busy) return; const mv = toMvc(amt.value); if (!(mv >= 1)) return U.toast('error', `Enter an amount of at least ${fmt(1)}.`);
        const to = document.getElementById('sTo').value.trim(); if (!to) return U.toast('error', 'Type the player name.');
        busy = true; const r = await call('bank', 'send', { to, amount: mv, note: document.getElementById('sNote').value, key: k }); busy = false;
        if (r) { U.toast('ok', `Sent ${fmt(r.amount)} to ${r.to}.`); bankApp(ph, 'home'); } else k = newKey();
      };
    } else if (tab === 'loan') {
      if (!o.canBorrow) { body.innerHTML = `<div class="card2"><b>Loans are for players aged 18+</b><p class="hint">You can still save and send money to friends.</p></div>`; return; }
      if (o.loan) {
        body.innerHTML = `<div class="card2"><b>Your loan</b><div class="list" style="margin-top:6px"><div class="li"><span>You borrowed</span><b>${fmt(o.loan.principal)}</b></div><div class="li"><span>Fee (${o.loanFeePercent}%)</span><b>${fmt(o.loan.fee)}</b></div><div class="li"><span>Left to pay</span><b>${fmt(o.loan.owed)}</b></div><div class="li"><span>Due</span><b class="${o.loan.overdue ? 'neg' : ''}">${when(o.loan.dueAt)}${o.loan.overdue ? ' (overdue)' : ''}</b></div></div></div>
          ${o.loan.overdue ? `<div class="warn">Overdue loans are collected automatically from up to 30% of your wallet each hour. Your items and home are never taken.</div>` : ''}
          <div class="card2 field"><label>Pay back (${esc(c.symbol)})</label><input id="rAmt" type="number" min="1" placeholder="${Math.ceil(o.loan.owed * c.perMVC)}"><button class="btn mint" id="rGo">Pay now</button><button class="btn ghost" id="rAll">Pay it all</button></div>`;
        let k = newKey();
        const pay = async (mv) => { const r = await call('bank', 'repay', { amount: mv, key: k }); k = newKey(); if (r) { U.toast('ok', r.cleared ? 'Loan fully paid. Well done!' : `Paid ${fmt(r.paid)}.`); bankApp(ph, 'loan'); } };
        document.getElementById('rGo').onclick = () => { const mv = toMvc(document.getElementById('rAmt').value); if (mv >= 1) pay(mv); else U.toast('error', 'Enter an amount.'); };
        document.getElementById('rAll').onclick = () => pay(o.loan.owed);
      } else {
        body.innerHTML = `<div class="card2 field"><b>Borrow</b><div class="hint">Your limit: <b>${fmt(o.loanLimit)}</b> (grows with reputation). Flat ${o.loanFeePercent}% fee, pay back within ${Math.round(o.loanTermHours / 24)} days.</div>
          <label>Amount (${esc(c.symbol)})</label><input id="lAmt" type="number" min="1" placeholder="${Math.floor(o.loanLimit * c.perMVC)}"><div class="hint" id="lFee"></div><button class="btn gold" id="lGo">Get loan</button></div>
          <div class="warn">Only borrow what you can repay. If you pay late, up to 30% of your wallet is collected each hour. Nothing else is taken.</div>`;
        const inp = document.getElementById('lAmt'); inp.oninput = () => { const mv = toMvc(inp.value); document.getElementById('lFee').textContent = mv ? `You will owe ${fmt(mv + Math.ceil(mv * o.loanFeePercent / 100))}` : ''; };
        let k = newKey();
        document.getElementById('lGo').onclick = async () => { const mv = toMvc(inp.value); if (!(mv >= 1)) return U.toast('error', 'Enter an amount.'); const r = await call('bank', 'borrow', { amount: mv, key: k }); k = newKey(); if (r) { U.toast('ok', `Loan received: ${fmt(r.principal)}.`); bankApp(ph, 'loan'); } };
      }
    } else {
      const names = { starting_grant: 'Welcome gift', shop_purchase: 'Shop', rent_initial: 'Rent', rent_renewal: 'Rent', wage: 'Wages', travel_fare: 'Travel', trade: 'Trade', admin_adjustment: 'Adjustment', p2p_transfer: 'Transfer', loan_disbursement: 'Loan', loan_repayment: 'Loan repayment', loan_collection: 'Loan collection', bet_stake: 'Odds bet', bet_payout: 'Odds win' };
      body.innerHTML = `<div class="list">${o.history.map((r) => `<div class="li"><div><b>${esc(names[r.type] ?? r.type.replace(/_/g, ' '))}</b><small>${when(r.at)}</small></div><span class="${r.delta >= 0 ? 'pos' : 'neg'}">${r.delta >= 0 ? '+' : ''}${fmt(r.delta)}</span></div>`).join('') || '<p>No transactions yet.</p>'}</div>`;
    }
  }

  // ------------------------------------------------------------------ Messages ("Chatter")
  async function messagesApp(ph, openWith) {
    if (openWith) return thread(ph, openWith.id, openWith.name);
    ph.app('Chatter', '<p>Loading…</p>');
    const d = await call('messages', 'inbox'); if (!d) return;
    G().phone.unread = 0; U.setPhoneBadge(0);
    ph.setBody(`<button class="btn mint" id="mNew">New message</button><div class="list">${d.chats.map((c) => `<button class="li" data-id="${c.id}" data-n="${esc(c.name)}" style="width:100%;text-align:left">${ava(c.name, '38px')}<div style="flex:1;min-width:0"><b>${esc(c.name)}</b><small style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.mine ? 'You: ' : ''}${esc(c.last)}</small></div>${c.unread ? `<span class="new bd" style="position:static">${c.unread}</span>` : ''}</button>`).join('') || '<p class="hint">No chats yet. Say hello to someone!</p>'}</div>`, (el) => {
      el.querySelectorAll('.li').forEach((b) => b.onclick = () => thread(ph, b.dataset.id, b.dataset.n));
      el.querySelector('#mNew').onclick = () => newChat(ph);
    });
    G().onNotify = (m) => { if (m.kind === 'message') messagesApp(ph); };
  }
  function newChat(ph) {
    ph.app('New message', `<div class="card2 field"><label>Player name</label><input id="nTo" maxlength="60" placeholder="Exact player name"><button class="btn mint" id="nGo">Start chat</button><div class="hint">You can only message players in your own age group. Be kind. You can block or report anyone.</div></div>`, () => {
      document.getElementById('nGo').onclick = () => { const n = document.getElementById('nTo').value.trim(); if (n) thread(ph, null, n); };
    });
  }
  async function thread(ph, id, name) {
    let other = id;
    const render = async () => {
      if (!other) return `<p class="hint">Say hello to <b>${esc(name)}</b>.</p>`;
      const d = await call('messages', 'thread', { with: other }); if (!d) return null;
      return d.messages.map((m) => `<div class="bub ${m.mine ? 'me' : ''}">${esc(m.body)}<small>${when(m.at)}</small></div>`).join('') || '<p class="hint">No messages yet.</p>';
    };
    ph.app(name, `<div class="thread" id="thr"><p>Loading…</p></div><div class="compose"><input id="tIn" maxlength="300" placeholder="Message…"><button class="btn small mint" id="tGo">${icon('send')}</button></div>
      ${other ? '<div style="display:flex;gap:6px"><button class="btn small ghost" id="tBlock">Block</button><button class="btn small ghost" id="tReport">Report</button></div>' : ''}`, async (el) => {
      const thr = el.querySelector('#thr'); const draw = async () => { const h = await render(); if (h != null) { thr.innerHTML = h; thr.scrollTop = thr.scrollHeight; } }; await draw();
      const go = async () => {
        const inp = el.querySelector('#tIn'); const text = inp.value.trim(); if (!text) return;
        const r = await call('messages', 'send', other ? { toId: other, text } : { to: name, text }); if (!r) return;
        inp.value = ''; if (!other) other = r.toId; await draw();
      };
      el.querySelector('#tGo').onclick = go; el.querySelector('#tIn').onkeydown = (e) => { if (e.key === 'Enter') go(); e.stopPropagation(); }; el.querySelector('#tIn').onkeyup = (e) => e.stopPropagation();
      const bl = el.querySelector('#tBlock'); if (bl) bl.onclick = () => { ctx.send({ t: 'block', targetId: other }); messagesApp(ph); };
      const rp = el.querySelector('#tReport'); if (rp) rp.onclick = () => U.reportDialog(name, (category, detail) => ctx.send({ t: 'report', targetId: other, category, detail }));
      G().onNotify = (m) => { if (m.kind === 'message' && m.fromId === other) draw(); };
    });
  }

  // ------------------------------------------------------------------ Spark (dating, adults only)
  async function loveApp(ph, tab = 'discover') {
    if (!adult()) return locked(ph, 'Spark');
    const st = await call('love', 'state'); if (!st) return;
    if (!st.profile) return loveProfile(ph, st, null);
    ph.app('Spark', `<div class="seg" id="lvTabs">${[['discover', 'Discover'], ['matches', `Matches${st.matches.length ? ' ' + st.matches.length : ''}`], ['me', 'Me']].map(([k, n]) => `<button data-k="${k}" class="${k === tab ? 'on' : ''}">${n}</button>`).join('')}</div><div id="lvBody" style="display:grid;gap:9px"></div>`, (el) => el.querySelectorAll('#lvTabs button').forEach((b) => b.onclick = () => loveApp(ph, b.dataset.k)));
    const body = document.getElementById('lvBody');
    if (tab === 'discover') {
      body.innerHTML = '<p>Finding people…</p>';
      const d = await call('love', 'discover'); if (!d || !document.getElementById('lvBody')) return;
      const queue = [...d.people];
      const show = () => {
        const p = queue.shift();
        if (!p) { body.innerHTML = `<div class="card2" style="text-align:center"><b>No one new right now</b><p class="hint">Check back soon, or tweak your profile.</p><button class="btn ghost" id="again">Refresh</button></div>`; body.querySelector('#again').onclick = () => loveApp(ph, 'discover'); return; }
        body.innerHTML = `<div class="pcard">${ava(p.name)}<div><b style="font-size:20px">${esc(p.name)}</b><div class="hint">${esc(p.city)} · ⭐ ${p.reputation}</div></div><div class="hint">Looking for: <b>${esc(p.lookingFor)}</b></div><div>${esc(p.bio)}</div><div class="chips" style="justify-content:center">${p.interests.map((i) => `<span class="chip">${esc(i)}</span>`).join('')}</div></div>
          <div class="row2"><button class="btn ghost" id="pass">Pass</button><button class="btn" id="like">${icon('heart')} Like</button></div><button class="btn small ghost" id="rep" style="justify-self:center">Report or block</button>`;
        const act = async (like) => { const r = await call('love', 'swipe', { id: p.id, like }); if (!r) return; if (r.matched) { U.toast('ok', `It's a match with ${r.name}!`); body.innerHTML = `<div class="pcard"><div style="font-size:40px">💞</div><b style="font-size:20px">It's a match!</b><div>You and ${esc(r.name)} like each other.</div><button class="btn mint" id="sayHi">Say hello</button><button class="btn ghost" id="nx">Keep browsing</button></div>`; body.querySelector('#sayHi').onclick = () => messagesApp(ph, { id: r.id, name: r.name }); body.querySelector('#nx').onclick = show; } else show(); };
        body.querySelector('#pass').onclick = () => act(false); body.querySelector('#like').onclick = () => act(true);
        body.querySelector('#rep').onclick = () => U.reportDialog(p.name, (category, detail) => { ctx.send({ t: 'report', targetId: p.id, category, detail }); ctx.send({ t: 'block', targetId: p.id }); show(); });
      };
      show();
    } else if (tab === 'matches') {
      body.innerHTML = st.matches.map((m) => `<div class="li">${ava(m.name, '40px')}<div style="flex:1;min-width:0"><b>${esc(m.name)}</b><small>${esc(m.lookingFor ?? '')}</small></div><button class="btn small mint" data-say="${m.id}" data-n="${esc(m.name)}">Message</button><button class="btn small ghost" data-un="${m.id}">✕</button></div>`).join('') || '<p class="hint">No matches yet. Like a few people on Discover!</p>';
      body.querySelectorAll('[data-say]').forEach((b) => b.onclick = () => messagesApp(ph, { id: b.dataset.say, name: b.dataset.n }));
      body.querySelectorAll('[data-un]').forEach((b) => b.onclick = async () => { await call('love', 'unmatch', { id: b.dataset.un }); loveApp(ph, 'matches'); });
    } else {
      body.innerHTML = `<div class="card2"><b>Your profile</b><p>${esc(st.profile.bio)}</p><div class="hint">Looking for: ${esc(st.profile.lookingFor)}</div><div class="chips" style="margin-top:6px">${st.profile.interests.map((i) => `<span class="chip on">${esc(i)}</span>`).join('')}</div></div>
        <button class="btn ghost" id="edit">Edit profile</button><button class="btn ghost" id="pz">${st.profile.active ? 'Pause my profile (hide me)' : 'Show my profile again'}</button><button class="btn danger" id="del">Delete my profile and matches</button>
        <div class="warn">Spark is for adults 18+. We never show your age or exact location. Never share passwords or send money to someone you just met. Use Report or block anytime.</div>`;
      body.querySelector('#edit').onclick = () => loveProfile(ph, st, st.profile);
      body.querySelector('#pz').onclick = async () => { await call('love', 'pause', { active: !st.profile.active }); loveApp(ph, 'me'); };
      body.querySelector('#del').onclick = async () => { if (confirm('Delete your Spark profile, likes and matches? This cannot be undone.')) { await call('love', 'remove'); loveApp(ph); } };
    }
  }
  function loveProfile(ph, st, existing) {
    const opt = st.options; const picked = new Set(existing?.interests ?? []);
    ph.app('Spark profile', `<div class="card2 field"><div class="hint">Spark is for adults 18+. Keep it friendly. Your name, city and reputation are shown to people you meet.</div>
      <label>About me</label><textarea id="pBio" rows="3" maxlength="${opt.bioMaxLength}" placeholder="A few friendly words…">${esc(existing?.bio ?? '')}</textarea>
      <label>Looking for</label><select id="pLook">${opt.lookingFor.map((l) => `<option ${existing?.lookingFor === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <label>Interests (up to 5)</label><div class="chips" id="pInt">${opt.interests.map((i) => `<button class="chip ${picked.has(i) ? 'on' : ''}" data-i="${esc(i)}">${esc(i)}</button>`).join('')}</div>
      <button class="btn" id="pSave">Save profile</button></div>`, (el) => {
      el.querySelectorAll('#pInt .chip').forEach((c) => c.onclick = () => { const i = c.dataset.i; if (picked.has(i)) picked.delete(i); else if (picked.size < 5) picked.add(i); c.classList.toggle('on', picked.has(i)); });
      el.querySelector('#pSave').onclick = async () => { const r = await call('love', 'save', { bio: el.querySelector('#pBio').value, lookingFor: el.querySelector('#pLook').value, interests: [...picked] }); if (r) loveApp(ph, 'discover'); };
    });
  }

  // ------------------------------------------------------------------ Odds (play-money betting, adults only)
  async function oddsApp(ph, sel = null) {
    if (!adult()) return locked(ph, 'Odds');
    const d = await call('odds', 'state'); if (!d) return;
    if (d.settled.won + d.settled.lost) U.toast(d.settled.paid ? 'ok' : 'info', d.settled.paid ? `You won ${fmt(d.settled.paid)}!` : 'Your bet did not win this time.');
    const L = d.limits; const lossPct = Math.min(100, Math.round((L.lossToday / L.dailyLossLimit) * 100));
    const secs = Math.max(0, Math.round((new Date(d.closesAt) - Date.now()) / 1000));
    const pickName = (f, p) => (p === 'home' ? f.home : p === 'away' ? f.away : 'Draw');
    ph.app('Odds', `<div class="warn"><b>Play money only · 18+.</b> MVC is a game currency and cannot be cashed out. The house edge is about ${L.marginPercent}%, so over time you lose. Never chase losses.</div>
      ${d.onBreakUntil ? `<div class="card2"><b>You are on a break</b><p class="hint">Betting is switched off until ${when(d.onBreakUntil)}. Good choice.</p></div>` : ''}
      <div class="card2"><div style="display:flex;justify-content:space-between"><b>Today's matches</b><small id="oTimer">Results in ${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s</small></div></div>
      ${d.fixtures.map((f) => `<div class="fx"><b>${esc(f.home)} <span style="opacity:.6">vs</span> ${esc(f.away)}</b><div class="odds">${['home', 'draw', 'away'].map((p) => `<button data-s="${f.slot}" data-p="${p}" class="${sel && sel.slot === f.slot && sel.pick === p ? 'on' : ''}" ${d.onBreakUntil ? 'disabled' : ''}>${p === 'home' ? '1' : p === 'draw' ? 'X' : '2'}<span>${f.odds[p].toFixed(2)}</span></button>`).join('')}</div>
        ${sel && sel.slot === f.slot ? `<div class="field"><label>Stake on ${esc(pickName(f, sel.pick))} (${esc(cur().symbol)})</label><input id="oStake" type="number" min="1" value="${Math.round(Math.min(L.maxStake, Math.max(L.minStake, 50)) * cur().perMVC)}"><div class="hint" id="oWin"></div><button class="btn gold" id="oGo">Place bet</button><div class="hint">Stakes ${fmt(L.minStake)} to ${fmt(L.maxStake)}.</div></div>` : ''}</div>`).join('')}
      <div class="card2"><small>Losses in the last 24h: ${fmt(L.lossToday)} of ${fmt(L.dailyLossLimit)}</small><div class="bar ${lossPct > 70 ? 'hot' : ''}" style="margin-top:6px"><i style="width:${lossPct}%"></i></div></div>
      <b>Last round's results</b><div class="list">${d.previousResults.map((r) => `<div class="li"><span>${esc(r.home)} ${r.homeGoals} – ${r.awayGoals} ${esc(r.away)}</span></div>`).join('')}</div>
      <b>My bets</b><div class="list">${d.bets.map((b) => `<div class="li"><div><b>${esc(b.match)}</b><small>Pick ${b.pick === 'home' ? '1' : b.pick === 'draw' ? 'X' : '2'} @ ${b.odds.toFixed(2)} · stake ${fmt(b.stake)}</small></div><span class="${b.status}">${b.status === 'won' ? '+' + fmt(b.payout) : b.status === 'lost' ? 'Lost' : 'Open'}</span></div>`).join('') || '<p class="hint">No bets yet.</p>'}</div>
      <div class="card2"><b>Take a break</b><p class="hint">Switch betting off for a while. You cannot undo it early.</p><div class="row2" style="grid-template-columns:repeat(${L.breakHours.length},1fr)">${L.breakHours.map((h) => `<button class="btn small ghost" data-br="${h}">${h >= 24 ? h / 24 + ' day' + (h > 24 ? 's' : '') : h + 'h'}</button>`).join('')}</div></div>`, (el) => {
      el.querySelectorAll('.odds button').forEach((b) => b.onclick = () => oddsApp(ph, { slot: Number(b.dataset.s), pick: b.dataset.p }));
      el.querySelectorAll('[data-br]').forEach((b) => b.onclick = async () => { if (confirm(`Turn betting off for ${b.textContent}? You cannot undo this.`)) { await call('odds', 'pause', { hours: Number(b.dataset.br) }); oddsApp(ph); } });
      const inp = el.querySelector('#oStake');
      if (inp) {
        const f = d.fixtures[sel.slot]; const upd = () => { const mv = toMvc(inp.value); el.querySelector('#oWin').textContent = mv ? `Stake ${mv.toLocaleString('en-US')} MVC · returns ${fmt(Math.floor(mv * f.odds[sel.pick]))} if it wins` : ''; }; inp.oninput = upd; upd();
        let k = newKey();
        el.querySelector('#oGo').onclick = async () => { const r = await call('odds', 'bet', { slot: sel.slot, pick: sel.pick, stake: toMvc(inp.value), key: k }); k = newKey(); if (r) { U.toast('ok', `Bet placed: ${fmt(r.stake)} on ${r.match}`); oddsApp(ph); } };
      }
      const tm = el.querySelector('#oTimer'); if (tm) { const iv = setInterval(() => { if (!document.body.contains(tm)) return clearInterval(iv); const s = Math.max(0, Math.round((new Date(d.closesAt) - Date.now()) / 1000)); tm.textContent = s ? `Results in ${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : 'Results ready: reopen'; }, 1000); }
    });
  }

  // ------------------------------------------------------------------ Home Store (furniture delivered to your backpack)
  const EMOJI = { single_bed: '🛏️', double_bed: '🛏️', starter_sofa: '🛋️', armchair: '💺', coffee_table: '☕', dining_table: '🍽️', dining_chair: '🪑', wardrobe: '🚪', bookshelf: '📚', tv_stand: '📺', fridge: '🧊', desk: '💻', desk_lamp: '💡', rug: '🟫', plant: '🪴' };
  async function storeApp(ph) {
    ph.app('Home Store', '<p>Loading…</p>');
    const d = await call('store', 'list'); if (!d) return;
    const have = (id) => G().summary.inventory.find((i) => i.itemId === id)?.quantity ?? 0;
    const draw = () => ph.setBody(`<div class="card2"><b>Furnish your home</b><small style="display:block;opacity:.8">Everything is delivered to your backpack. Then open your home and tap <b>Furnish</b> (the sofa button on the right).</small><button class="btn mint" id="stFurn" style="margin-top:8px">Go and furnish</button></div>
      <div class="list">${d.items.map((i) => `<div class="li"><div style="display:flex;gap:10px;align-items:center"><span style="font-size:26px">${EMOJI[i.itemId] ?? '📦'}</span><div><b>${esc(i.name)}</b><small>${i.size ? `${i.size.sx}×${i.size.sz} m` : ''}${have(i.itemId) ? ` · you have ${have(i.itemId)}` : ''}</small></div></div><button class="btn small gold" data-buy="${i.itemId}">${fmt(i.price)}</button></div>`).join('')}</div>`, (el) => {
      el.querySelector('#stFurn').onclick = () => ctx.furnish();
      el.querySelectorAll('[data-buy]').forEach((b) => b.onclick = async () => { const r = await call('store', 'buy', { itemId: b.dataset.buy, key: newKey() }); if (r) { U.toast('ok', 'Delivered to your backpack.'); setTimeout(draw, 200); } });
    });
    draw();
  }

  // ------------------------------------------------------------------ Top up (real money -> MVC)
  const money = (cur, minor) => (cur === 'USD' ? '$' : '₦') + (minor / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const STATUS = { pending: ['Waiting for payment', 'dim'], review: ['Being checked', ''], paid: ['Paid', ''], failed: ['Failed', 'dim'], cancelled: ['Expired', 'dim'], rejected: ['Declined', 'dim'] };
  let topupTimer = null;
  async function topupApp(ph, st = { cur: 'NGN', pack: null }) {
    clearInterval(topupTimer);
    ph.app('Top up', '<p>Loading…</p>');
    const d = await call('topup', 'info'); if (!d) return;
    const packId = st.pack ?? d.packs.find((p) => p.best)?.id ?? d.packs[0].id;
    const adultOk = adult();
    const pk = d.packs.find((p) => p.id === packId);
    const price = (p) => (st.cur === 'USD' ? `$${p.usd}` : `₦${p.ngn.toLocaleString('en-US')}`);
    const orderRow = (o) => { const [label, cls] = STATUS[o.status] ?? [o.status, 'dim'];
      return `<div class="li" data-o="${o.id}"><div><b>+${o.mvc.toLocaleString('en-US')} MVC</b><small>${esc(o.provider)} · ${money(o.currency, o.amountMinor)} · ${esc(o.reference)}</small></div><div style="text-align:right"><span class="pill ${cls}">${label}</span>${o.status === 'pending' && o.provider !== 'manual' ? `<br><button class="btn small" data-check="${o.id}">Check payment</button>` : ''}${o.status === 'pending' && o.provider !== 'manual' && o.checkoutUrl ? `<br><a href="${esc(o.checkoutUrl)}" target="_blank" rel="noopener" style="font-size:12px;color:#9fe">Open payment page</a>` : ''}${o.status === 'pending' && o.provider === 'manual' ? `<br><button class="btn small mint" data-paid="${o.id}">I have paid</button>` : ''}</div></div>`; };
    const html = `<div class="card2"><small>Balance</small><div class="bignum">${fmt(G().summary.balance)}</div><small>≈ ${G().summary.balance.toLocaleString('en-US')} MVC</small></div>
      ${adultOk ? '' : `<div class="card2"><b>🔒 Players aged ${d.minAge}+ only</b><div class="hint">Buying game money with real money is only for adult accounts.</div></div>`}
      <div class="seg" id="tuCur"><button data-c="NGN" class="${st.cur === 'NGN' ? 'on' : ''}">₦ Naira</button><button data-c="USD" class="${st.cur === 'USD' ? 'on' : ''}">$ USD</button></div>
      <div class="list" id="tuPacks">${d.packs.map((p) => `<button class="li" data-p="${p.id}" style="width:100%;text-align:left;${p.id === packId ? 'outline:2px solid #5be0a8' : ''}"><div style="display:flex;gap:10px;align-items:center"><span style="font-size:26px">${p.emoji}</span><div><b>+₦${(p.mvc * 100).toLocaleString('en-US')} game money</b><small>${esc(p.name)} · ${p.mvc.toLocaleString('en-US')} MVC${p.best ? ' · best value' : ''}</small></div></div><span class="pill">${price(p)}</span></button>`).join('')}</div>
      <div class="card2"><b>Pay ${price(pk)} with</b><div style="display:grid;gap:8px;margin-top:8px">
        ${d.providers.map((p) => `<button class="btn ${p.available && p.currencies.includes(st.cur) && adultOk ? 'mint' : ''}" data-pay="${p.id}" ${p.available && p.currencies.includes(st.cur) && adultOk ? '' : 'disabled'}>${esc(p.name)} <small style="opacity:.8">· ${esc(p.how)}${p.available ? '' : ' · not set up yet'}${p.available && !p.currencies.includes(st.cur) ? ` · no ${st.cur}` : ''}</small></button>`).join('')}
        <button class="btn" data-pay="manual" ${d.manual.available && adultOk ? '' : 'disabled'}>${esc(d.manual.name)} <small style="opacity:.8">· ${d.manual.available ? 'an admin confirms it' : 'not set up yet'}</small></button></div>
        <div class="hint">You are sent to the provider's secure page to pay; the game never sees your card. Your MVC arrives as soon as the provider confirms (usually seconds). Game money cannot be cashed out or refunded to real money.</div></div>
      <b>Your top-ups</b><div class="list" id="tuOrders">${d.orders.length ? d.orders.map(orderRow).join('') : '<p class="hint">Nothing yet.</p>'}</div>`;
    ph.setBody(html, (el) => {
      el.querySelectorAll('#tuCur button').forEach((b) => b.onclick = () => topupApp(ph, { cur: b.dataset.c, pack: packId }));
      el.querySelectorAll('#tuPacks [data-p]').forEach((b) => b.onclick = () => topupApp(ph, { cur: st.cur, pack: b.dataset.p }));
      const afterCredit = (r) => { if (r?.credited) { U.toast('ok', `+${r.order.mvc.toLocaleString('en-US')} MVC added to your wallet.`); return true; } return false; };
      el.querySelectorAll('[data-check]').forEach((b) => b.onclick = async () => { const r = await call('topup', 'check', { id: b.dataset.check }); if (!r) return; if (r.unreachable) U.toast('info', 'The payment provider did not answer. Try again in a moment.'); else if (!afterCredit(r)) U.toast('info', 'Not paid yet.'); topupApp(ph, st); });
      el.querySelectorAll('[data-paid]').forEach((b) => b.onclick = () => {
        ph.setBody(`<div class="card2 field"><b>Tell us about your transfer</b><label>Name on the bank account you paid from</label><input id="tuName" maxlength="80"><label>Note (optional)</label><input id="tuNote" maxlength="200" placeholder="time, bank, anything that helps"><button class="btn mint" id="tuSend">Send for checking</button><button class="btn" id="tuBack">Back</button></div>`, (e2) => {
          e2.querySelector('#tuBack').onclick = () => topupApp(ph, st);
          e2.querySelector('#tuSend').onclick = async () => { const nm = e2.querySelector('#tuName').value.trim(); if (nm.length < 2) return U.toast('error', 'Type the name on the account.'); const r = await call('topup', 'submit', { id: b.dataset.paid, senderName: nm, note: e2.querySelector('#tuNote').value }); if (r) { U.toast('ok', 'Thanks. An admin will check your transfer and add your MVC.'); topupApp(ph, st); } };
        });
      });
      el.querySelectorAll('[data-pay]').forEach((b) => b.onclick = async () => {
        const provider = b.dataset.pay;
        const r = await call('topup', 'start', { provider, pack: packId, currency: st.cur }); if (!r) return;
        if (provider === 'manual') {
          ph.setBody(`<div class="card2"><b>Pay ${money(r.order.currency, r.order.amountMinor)} by bank transfer</b><div style="white-space:pre-wrap;margin:8px 0">${esc(r.instructions)}</div><div class="card2"><small>Use this reference</small><div class="bignum" style="font-size:22px;letter-spacing:1px">${esc(r.order.reference)}</div></div><div class="hint">After you transfer, come back and tap <b>I have paid</b> next to this order.</div><button class="btn mint" id="tuOk">Done</button></div>`, (e2) => e2.querySelector('#tuOk').onclick = () => topupApp(ph, st));
          return;
        }
        window.open(r.order.checkoutUrl, '_blank', 'noopener');
        U.toast('info', 'Complete the payment in the new tab. We will add your MVC as soon as it is confirmed.');
        let tries = 0;
        topupTimer = setInterval(async () => {   // while this screen is open, ask about the payment every few seconds
          if (!document.getElementById('tuOrders') || ++tries > 120) return clearInterval(topupTimer);
          const c = await ctx.ask({ app: 'topup', a: 'check', d: { id: r.order.id } });
          if (c.ok && c.data.order.status !== 'pending') { clearInterval(topupTimer); afterCredit(c.data) || U.toast('info', `Payment ${c.data.order.status}.`); topupApp(ph, st); }
        }, 4000);
        topupApp(ph, st);
      });
    });
  }

  // ------------------------------------------------------------------ Contacts, Help, Places, Soon
  async function contactsApp(ph) {
    ph.app('Contacts', '<p>Loading…</p>');
    const d = await call('contacts', 'list'); if (!d) return;
    ph.setBody(`<b>People you have chatted with</b><div class="list">${d.chats.length ? d.chats.map((c) => `<div class="li"><div style="display:flex;gap:10px;align-items:center">${ava(c.name, '34px')}<b>${esc(c.name)}</b></div><button class="btn small" data-msg="${c.id}" data-name="${esc(c.name)}">Message</button></div>`).join('') : '<p class="hint">No chats yet. Tap a player in the world and choose Message.</p>'}</div>
      <b>Blocked players</b><div class="list">${d.blocked.length ? d.blocked.map((b) => `<div class="li"><b>${esc(b.displayName)}</b><button class="btn small" data-unb="${b.characterId}">Unblock</button></div>`).join('') : '<p class="hint">You have not blocked anyone. To block or report someone, tap them in the world.</p>'}</div>`, (el) => {
      el.querySelectorAll('[data-msg]').forEach((b) => b.onclick = () => messagesApp(ph, { id: b.dataset.msg, name: b.dataset.name }));
      el.querySelectorAll('[data-unb]').forEach((b) => b.onclick = async () => { if (await call('contacts', 'unblock', { id: b.dataset.unb })) { U.toast('ok', 'Unblocked.'); contactsApp(ph); } });
    });
  }
  function helpApp(ph) {
    ph.app('Help & guide', `<div class="card2"><b>Moving</b><div class="hint">WASD or arrow keys (hold Shift to run). On a phone use the on-screen stick. Tap a floating label in city view to travel there.</div></div>
      <div class="card2"><b>Keys</b><div class="hint">E use or buy · Enter chat · T hold to talk (voice, 18+) · V city view · M map · P phone</div></div>
      <div class="card2"><b>Money</b><div class="hint">Everything is paid in MVC; your wallet shows the local currency of the country you are in. Earn from Jobs, buy and sell homes in Homes, top up in <b>Top up</b>. Game money cannot be cashed out.</div></div>
      <div class="card2"><b>Safety</b><div class="hint">Tap any player to message, block or report them. Reports send the recent messages between you and them to the moderators. Voice and betting are 18+ only. Never share your password; staff will never ask for it.</div></div>`);
  }
  function placesApp(ph) {
    const S = ctx.S, here = G().city, me = G().me;
    const list = (S.world.pois ?? []).filter((p) => p.district === here.id).map((p) => ({ p, d: Math.hypot(p.x - me.x, p.z - me.z) })).sort((a, b) => a.d - b.d);
    ph.app('Places', `<div class="hint" style="margin-bottom:6px">Businesses and landmarks in ${esc(here.name)}. Tap one to get there on foot, by bike, bus or taxi.</div><div class="list">${list.map(({ p, d }) => `<button class="li" data-poi="${p.id}" style="width:100%;text-align:left"><div><b>${p.emoji ?? '📍'} ${esc(p.name)}</b><small>${esc(p.type)}${p.enterable ? ' · open to the public' : ''}</small></div><span class="pill">${d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(1) + ' km'}</span></button>`).join('') || '<p class="hint">Nothing listed here.</p>'}</div>`, (el) => {
      el.querySelectorAll('[data-poi]').forEach((b) => b.onclick = () => ctx.openPlace(list.find((x) => x.p.id === b.dataset.poi).p));
    });
  }
  const soon = (id, name, emoji, color, blurb) => ({ id, name, emoji, color, soon: true, open: (ph) => ph.app(name, `<div class="card2" style="text-align:center"><div style="font-size:44px">${emoji}</div><b>${esc(name)} is coming soon</b><p class="hint">${esc(blurb)}</p></div>`) });
  return [
    { id: 'bank', name: 'Vault', icon: 'bank', color: GRAD.bank, open: (ph) => bankApp(ph) },
    { id: 'topup', name: 'Top up', emoji: '💳', color: 'linear-gradient(135deg,#0ea5e9,#22d3ee)', isNew: true, open: (ph) => topupApp(ph) },
    { id: 'chat', name: 'Chatter', icon: 'chat', color: GRAD.chat, badge: G().phone?.unread || 0, open: (ph, arg) => messagesApp(ph, arg) },
    { id: 'love', name: 'Spark', icon: 'heart', color: GRAD.love, adult: true, open: (ph) => loveApp(ph) },
    { id: 'odds', name: 'Odds', icon: 'dice', color: GRAD.odds, adult: true, open: (ph) => oddsApp(ph) },
    { id: 'jobs', name: 'Jobs', icon: 'brief', color: GRAD.jobs, open: async (ph) => {
      ph.app('Jobs', '<p>Loading…</p>');
      const d = await phoneAsk('jobs');
      ph.setBody(`<div class="list">${d.jobs.map((j) => `<div class="li"><div><b>${esc(j.name)}</b><small>${esc(j.employer)} · ${j.tasksPerShift} tasks</small></div><div class="pos">+${fmt(j.wagePerShift)}</div></div>`).join('')}</div><b>Recent shifts</b><div class="list">${d.history.map((s) => `<div class="li"><div><b>${esc(s.jobId.replace(/^job_/, '').replace(/_/g, ' '))}</b><small>${esc(s.status)} · ${s.tasksDone}/${s.tasksRequired} tasks</small></div><div class="pos">${s.wage ? '+' + fmt(s.wage) : ''}</div></div>`).join('') || '<p style="opacity:.8">No shifts yet. Find a work station!</p>'}</div>`);
    } },
    { id: 'goals', name: 'Goals', icon: 'star', color: GRAD.goals, open: async (ph) => {
      ph.app('Goals', '<p>Loading…</p>');
      const d = await phoneAsk('achievements');
      ph.setBody(`<div class="card2">⭐ Reputation <b>${d.reputation}</b></div><div class="list">${d.achievements.map((a) => `<div class="li"><div><b>${a.earned ? '✅' : '⬜'} ${esc(a.name)}</b><small>${a.reputation ? `+${a.reputation} reputation` : 'Milestone'}</small></div></div>`).join('')}</div><b>Skills</b><div class="list">${d.skills.map((s) => `<div class="li"><b>${esc(s.skillId)}</b><span>${s.xp} xp</span></div>`).join('') || '<p style="opacity:.8">Work shifts to build skills.</p>'}</div>`);
    } },
    { id: 'store', name: 'Home Store', icon: 'sofa', color: 'linear-gradient(135deg,#7c3aed,#c084fc)', open: (ph) => storeApp(ph) },
    { id: 'estate', name: 'Homes', icon: 'home', color: 'linear-gradient(135deg,#c2410c,#fb923c)', open: () => ctx.openEstate() },
    { id: 'map', name: 'Maps', icon: 'map', color: GRAD.map, open: () => ctx.openMap() },
    { id: 'contacts', name: 'Contacts', emoji: '📞', color: 'linear-gradient(135deg,#16a34a,#86efac)', isNew: true, open: (ph) => contactsApp(ph) },
    { id: 'places', name: 'Places', emoji: '🛍️', color: 'linear-gradient(135deg,#e11d48,#fb7185)', isNew: true, open: (ph) => placesApp(ph) },
    { id: 'ride', name: 'Ride', emoji: '🚕', color: 'linear-gradient(135deg,#f59e0b,#fde047)', isNew: true, open: () => ctx.rideHelp() },
    { id: 'invest', name: 'Invest', emoji: '📈', color: 'linear-gradient(135deg,#65a30d,#bef264)', isNew: true, open: () => ctx.openEstate() },
    { id: 'help', name: 'Help & guide', emoji: '💡', color: 'linear-gradient(135deg,#eab308,#fde68a)', isNew: true, open: (ph) => helpApp(ph) },
    soon('cars', 'Cars', '🚗', 'linear-gradient(135deg,#3b82f6,#1e40af)', 'Buy, own and drive a car around the city instead of paying for taxis.'),
    soon('health', 'Health', '💊', 'linear-gradient(135deg,#f43f5e,#fb7185)', 'Energy and wellbeing, clinics and hospitals that treat you.'),
    soon('courses', 'Courses', '🎓', 'linear-gradient(135deg,#2563eb,#1e3a8a)', 'Study to unlock better jobs and higher pay.'),
    soon('assurance', 'Assurance', '🛡️', 'linear-gradient(135deg,#0f766e,#14b8a6)', 'Insure your home and belongings.'),
    soon('police', 'Police', '🚓', 'linear-gradient(135deg,#1d4ed8,#312e81)', 'Report crimes in the world and track the cases.'),
    soon('court', 'Court', '⚖️', 'linear-gradient(135deg,#78350f,#b45309)', 'Settle disputes between players.'),
    soon('gov', 'City Gov', '🏛️', 'linear-gradient(135deg,#15803d,#4ade80)', 'Permits, taxes and city announcements.'),
    soon('company', 'Company', '🏢', 'linear-gradient(135deg,#0d9488,#99f6e4)', 'Start and manage your own business, with staff and customers.'),
    { id: 'settings', name: 'Settings', icon: 'gear', color: GRAD.settings, open: (ph) => {
      const c = cur(), city = G().city;
      ph.app('Settings', `<div class="card2"><div class="list"><div class="li"><span>City</span><b>${esc(city.name)}</b></div><div class="li"><span>Country</span><b>${esc(c.flag)} ${esc(c.countryName)}</b></div><div class="li"><span>Currency</span><b>${esc(c.symbol)} ${esc(c.code)}</b></div><div class="li"><span>Age group</span><b>${adult() ? '18+' : 'Under 18'}</b></div></div></div>`);
    } },
  ];
}
