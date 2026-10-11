// Phone apps. Each app asks the game server for data/actions; the server decides everything.
import { icon, esc } from './ui.js';

const GRAD = {
  bank: 'linear-gradient(135deg,#1f8a70,#5be0a8)', jobs: 'linear-gradient(135deg,#2a6fdb,#6cc4ff)', goals: 'linear-gradient(135deg,#d97706,#f4b942)',
  map: 'linear-gradient(135deg,#0d6b78,#4ad0c0)', settings: 'linear-gradient(135deg,#475569,#94a3b8)',
};

export function phoneApps(ctx) {
  const G = ctx.G, fmt = ctx.fmt;
  const phoneAsk = (tab) => new Promise((resolve) => { G().phoneWait = (m) => { if (m.tab === tab) { G().phoneWait = null; resolve(m.data); } }; ctx.send({ t: 'phone', tab }); });
  return [
    { id: 'bank', name: 'Bank', icon: 'bank', color: GRAD.bank, open: async (ph) => {
      const s = G().summary, cur = G().currency;
      ph.app('Bank', `<div class="card2"><small>Balance</small><div class="bignum">${fmt(s.balance)}</div><small>≈ ${s.balance.toLocaleString('en-US')} MVC · ${esc(cur.flag)} ${esc(cur.name)}</small></div><div id="bankRest"><p>Loading…</p></div>`);
      const rows = await phoneAsk('wallet');
      const rates = ctx.S.geo.countries.map((c) => `<div class="li"><span>${c.flag} ${esc(c.currency.code)}</span><b>1 MVC = ${c.currency.symbol}${c.currency.perMVC}</b></div>`).join('');
      const names = { starting_grant: 'Welcome gift', shop_purchase: 'Shop', rent_initial: 'Rent', rent_renewal: 'Rent', wage: 'Wages', travel_fare: 'Travel', trade: 'Trade', admin_adjustment: 'Adjustment' };
      const el = document.getElementById('bankRest'); if (!el) return;
      el.innerHTML = `<div class="card2"><b>Exchange rates</b><small style="display:block;margin-bottom:6px;opacity:.8">Game rates, fixed. Your wallet shows prices in the currency of the country you are in.</small><div class="list">${rates}</div></div><b style="margin-top:4px;display:block">Recent activity</b><div class="list">${rows.map((r) => `<div class="li"><div><b>${esc(names[r.type] ?? r.type.replace(/_/g, ' '))}</b><small>${new Date(r.at).toLocaleString()}</small></div><div><span class="${r.delta >= 0 ? 'pos' : 'neg'}">${r.delta >= 0 ? '+' : ''}${fmt(r.delta)}</span></div></div>`).join('') || '<p>No transactions yet.</p>'}</div>`;
    } },
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
    { id: 'map', name: 'Maps', icon: 'map', color: GRAD.map, open: () => ctx.openMap() },
    { id: 'settings', name: 'Settings', icon: 'gear', color: GRAD.settings, open: (ph) => {
      const c = G().currency, city = G().city;
      ph.app('Settings', `<div class="card2"><div class="list"><div class="li"><span>City</span><b>${esc(city.name)}</b></div><div class="li"><span>Country</span><b>${esc(c.flag)} ${esc(c.countryName)}</b></div><div class="li"><span>Currency</span><b>${esc(c.symbol)} ${esc(c.code)}</b></div></div></div>`);
    } },
  ];
}
