/* Zsold demo: kitalált adatok és egy memóriában futó adatbázis-utánzat.
   Semmi nem megy a valódi adatbázisba; újratöltéskor minden visszaáll.
   Az adatok a mai naphoz igazodnak, így a demó mindig "friss". */
(function () {
  // Csak a ?demo címen fut; a saját appban azonnal kilép, és nem nyúl semmihez.
  if (!/(^|&)demo(=|&|$)/.test(location.search.slice(1))) return;
  window.ZSOLD_DEMO = true;

  // Determinisztikus véletlen, hogy a demó minden betöltéskor ugyanúgy nézzen ki.
  let seed = 20261021;
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const between = (a, b, step = 10) => Math.round((a + rnd() * (b - a)) / step) * step;
  const pad = n => String(n).padStart(2, '0');
  const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);

  const now = new Date(); now.setHours(12, 0, 0, 0);
  const TODAY = iso(now);
  const daysBack = n => { const d = new Date(now); d.setDate(d.getDate() - n); return d; };
  const isWeekday = d => d.getDay() !== 0 && d.getDay() !== 6;

  /* ---------- árfolyamok (visszafelé generált véletlen bolyongás a mai szintekből) ---------- */
  function walk(endPrice, days, vol, drift, weekdaysOnly) {
    const rows = []; let p = endPrice;
    for (let i = 0; i <= days; i++) {
      const d = daysBack(i);
      if (weekdaysOnly && !isWeekday(d)) continue;
      rows.push({ d: iso(d), p });
      p = p / Math.exp(drift + vol * gauss());
    }
    return rows.reverse();
  }
  const SPAN = 220;
  const fxE = walk(364.2, SPAN, 0.0028, -0.00005, true), fxU = walk(325.4, SPAN, 0.0040, -0.0001, true), fxC = walk(390.1, SPAN, 0.0030, 0, true);
  const fx_rates = fxE.map((r, i) => ({ d: r.d, eur: +r.p.toFixed(2), usd: +fxU[i].p.toFixed(2), chf: +fxC[i].p.toFixed(2) }));
  const fxOn = d => { let r = fx_rates[0]; for (const x of fx_rates) { if (x.d <= d) r = x; else break; } return r; };

  const INST = [
    { ticker: 'VWCE', name: 'Vanguard FTSE All-World UCITS ETF (Acc)', ccy: 'EUR', hist: walk(173.1, SPAN, 0.008, 0.0005, true) },
    { ticker: 'EQQQ', name: 'Invesco EQQQ Nasdaq-100 UCITS ETF', ccy: 'EUR', hist: walk(666.9, SPAN, 0.012, 0.0007, true) },
    { ticker: 'BTC/EUR', name: 'Bitcoin', ccy: 'EUR', hist: walk(74440, SPAN, 0.025, 0.0006, false) },
  ];
  const priceOn = (inst, d) => { let r = inst.hist[0].p; for (const x of inst.hist) { if (x.d <= d) r = x.p; else break; } return r; };
  const instruments = INST.map(i => ({ id: uid(), ticker: i.ticker, name: i.name, sector: '', ccy: i.ccy, price: +i.hist[i.hist.length - 1].p.toFixed(i.ticker === 'BTC/EUR' ? 2 : 2), price_at: now.toISOString(), source: 'demo' }));
  const price_history = INST.flatMap(i => i.hist.map(x => ({ user_id: 'demo', ticker: i.ticker, d: x.d, price: +x.p.toFixed(2) })));

  /* ---------- számlák ---------- */
  const accounts = [
    { name: 'Főszámla', type: 'Bankszámla', ccy: 'HUF', opening: 186400, sort: 0 },
    { name: 'Készpénz', type: 'Készpénz', ccy: 'HUF', opening: 32000, sort: 1 },
    { name: 'Deviza EUR', type: 'Bankszámla', ccy: 'EUR', opening: 240, sort: 2 },
    { name: 'Bróker EUR', type: 'Brókerszámla', ccy: 'EUR', opening: 1450, sort: 3 },
  ].map(a => ({ id: uid(), ...a }));

  /* ---------- pénzmozgások: kb. fél év egy egyetemista életéből ---------- */
  const cash = [];
  const add = (date, type, cat, descr, acct, amount, ccy = 'HUF', to_acct = '') => { if (date <= TODAY) cash.push({ id: uid(), date, type, cat, descr, acct, to_acct, ccy, amount, created_at: date + 'T12:00:00Z' }); };
  const trades = [];
  const buy = (date, inst, eur) => {
    if (date > TODAY) return;
    const p = priceOn(inst, date), dec = inst.ticker === 'BTC/EUR' ? 8 : 4;
    const qty = +(eur / p).toFixed(dec);
    trades.push({ id: uid(), ticker: inst.ticker, type: 'Vétel', ccy: 'EUR', qty, price: +p.toFixed(2), wht: 0, extra: 0, date, account: 'Bróker EUR', created_at: date + 'T12:00:00Z' });
  };

  const first = daysBack(190); first.setDate(1);
  // Nyitó portfólió az időszak elején
  const d0 = iso(first);
  buy(d0, INST[0], 820); buy(d0, INST[1], 260); buy(d0, INST[2], 120);

  for (let m = new Date(first); m <= now; m.setMonth(m.getMonth() + 1)) {
    const Y = m.getFullYear(), M = m.getMonth() + 1, ym = `${Y}-${pad(M)}`, last = new Date(Y, M, 0).getDate();
    const day = n => `${ym}-${pad(Math.min(n, last))}`;
    const isCurrent = ym === TODAY.slice(0, 7);

    add(day(1), 'Átvezetés', '', 'Készpénzfelvétel', 'Főszámla', 20000, 'HUF', 'Készpénz');
    add(day(1), 'Kiadás', 'Közlekedés', 'BKK diákbérlet', 'Főszámla', 3450);
    add(day(5), 'Bevétel', 'Munkabér', 'Diákmunka', 'Főszámla', between(128000, 152000, 500));
    add(day(10), 'Bevétel', 'Ösztöndíj', 'Tanulmányi ösztöndíj', 'Főszámla', 33000);
    add(day(12), 'Kiadás', 'Előfizetések', 'Spotify', 'Főszámla', 1790);
    add(day(15), 'Kiadás', 'Telefon, internet', 'Telefonszámla', 'Főszámla', 4990);
    if (!isCurrent) add(day(3), 'Kiadás', 'Előfizetések', 'Netflix', 'Deviza EUR', 9.99, 'EUR');

    // Havi befektetés: forint átvezetés a brókerhez, majd ETF- és BTC-vétel
    const inv = 40000, invDate = day(6);
    if (invDate <= TODAY) {
      add(invDate, 'Átvezetés', '', 'Havi befektetés', 'Főszámla', inv, 'HUF', 'Bróker EUR');
      const eur = inv / fxOn(invDate).eur;
      buy(day(7), INST[0], eur * 0.7); buy(day(7), INST[1], eur * 0.2); buy(day(7), INST[2], eur * 0.1);
    }
    if (M % 3 === 0) add(day(20), 'Átvezetés', '', 'Euró váltás', 'Főszámla', 12000, 'HUF', 'Deviza EUR');

    // Hétköznapi költések
    for (let dd = 1; dd <= last; dd++) {
      const date = day(dd), wd = new Date(Y, M - 1, dd).getDay();
      if (wd === 6 || (wd === 3 && rnd() < 0.5)) add(date, 'Kiadás', 'Élelmiszer', pick(['Lidl', 'Tesco', 'Aldi', 'Spar']) + ' bevásárlás', rnd() < 0.6 ? 'Főszámla' : 'Készpénz', between(3200, 9800));
      if (wd >= 1 && wd <= 5 && rnd() < 0.32) add(date, 'Kiadás', 'Étterem, kávé', 'Kávé', 'Készpénz', between(650, 1150));
      if (wd >= 1 && wd <= 5 && rnd() < 0.16) add(date, 'Kiadás', 'Étterem, kávé', pick(['Ebéd a menzán', 'Gyros', 'Pho leves', 'Pizza szelet']), 'Főszámla', between(1900, 3900));
      if ((wd === 5 || wd === 0) && rnd() < 0.22) add(date, 'Kiadás', 'Étterem, kávé', 'Wolt rendelés', 'Főszámla', between(4200, 6900));
    }
    add(day(9 + Math.floor(rnd() * 15)), 'Kiadás', 'Szórakozás', pick(['Mozi', 'Bowling a csoporttal', 'Koncertjegy', 'Escape room']), 'Főszámla', pick([3200, 4500, 12900, 6000]));
    if (M % 2 === 0) add(day(18), 'Kiadás', 'Ruházat', pick(['H&M póló', 'Decathlon futócipő', 'Pulóver', 'Farmer']), 'Főszámla', pick([5990, 18990, 9990, 12990]));
    if (rnd() < 0.4) add(day(22), 'Kiadás', 'Egészség', 'Patika', 'Készpénz', between(1800, 4200));
    if (M === 9) add(day(8), 'Kiadás', 'Tanulmányok', 'Tankönyvek', 'Főszámla', 8600);
    if (rnd() < 0.3) add(day(25), 'Kiadás', 'Ajándék', 'Szülinapi ajándék', 'Főszámla', between(5000, 12000, 500));
    if (rnd() < 0.5) add(day(26), 'Kiadás', 'Közlekedés', 'Bolt fuvar', 'Főszámla', between(2100, 3800));
  }
  // Egy-két tétel kategória nélkül, hogy látszódjon a "besorolandó" jelölés
  add(iso(daysBack(2)), 'Kiadás', '', 'Kártyás fizetés', 'Főszámla', 2490);

  const settings = [{
    user_id: 'demo',
    categories: ['Munkabér', 'Ösztöndíj', 'Egyéb bevétel', 'Élelmiszer', 'Étterem, kávé', 'Lakhatás', 'Rezsi', 'Közlekedés', 'Telefon, internet', 'Előfizetések', 'Ruházat', 'Egészség', 'Tanulmányok', 'Szórakozás', 'Ajándék', 'Egyéb kiadás'],
    tax: [2024, 2025, 2026, 2027].map(y => ({ y, div: 0.15, szocho: 0.13 })),
    rules: {
      defaultAcct: 'Készpénz', cardAcct: 'Főszámla',
      keywords: [
        { k: 'spotify', type: 'Kiadás', cat: 'Előfizetések', acct: 'Főszámla', amount: 1790, ccy: 'HUF', desc: 'Spotify' },
        { k: 'netflix', type: 'Kiadás', cat: 'Előfizetések', acct: 'Deviza EUR', amount: 9.99, ccy: 'EUR', desc: 'Netflix' },
      ],
      recurring: [{ desc: 'Netflix', type: 'Kiadás', cat: 'Előfizetések', acct: 'Deviza EUR', amount: 9.99, ccy: 'EUR', day: 3, start: TODAY.slice(0, 7), skip: [] }],
    },
  }];

  const D = { accounts, trades, cash, instruments, price_history, fx_rates, settings };

  /* ---------- a supabase-js azon része, amit az app használ ---------- */
  const query = t => {
    const st = { op: 'select' };
    const o = {
      select() { return o; }, range() { return o; }, order() { return o; },
      eq(k, v) { st.eq = [k, v]; return o; },
      upsert(row) { st.op = 'upsert'; st.row = row; return o; },
      delete() { st.op = 'delete'; return o; },
      then(res, rej) {
        try {
          if (st.op === 'select') return res({ data: (D[t] || []).slice(), error: null });
          if (st.op === 'upsert') {
            const r = Object.assign({}, st.row);
            if (t === 'settings') D.settings = [Object.assign({}, D.settings[0], r)];
            else if (t === 'instruments') { const i = D.instruments.findIndex(x => x.ticker === r.ticker); if (i >= 0) D.instruments[i] = Object.assign({}, D.instruments[i], r); else D.instruments.push(Object.assign({ id: uid() }, r)); }
            else { if (!r.id) r.id = uid(); r.created_at = r.created_at || new Date().toISOString(); const i = D[t].findIndex(x => x.id === r.id); if (i >= 0) D[t][i] = r; else D[t].push(r); }
            return res({ error: null });
          }
          D[t] = D[t].filter(x => x[st.eq[0]] !== st.eq[1]); return res({ error: null });
        } catch (e) { rej(e); }
      },
    };
    return o;
  };
  const session = { user: { id: 'demo', email: 'demo@zsold.app' } };
  window.supabase = {
    createClient() {
      return {
        from: query,
        auth: {
          onAuthStateChange(cb) { setTimeout(() => cb('SIGNED_IN', session), 0); return { data: { subscription: { unsubscribe() {} } } }; },
          async signInWithPassword() { return { error: null }; },
          async signOut() { location.href = '/'; },
          async getUser() { return { data: { user: session.user } }; },
        },
      };
    },
  };
  window.ZSOLD_CONFIG = { url: 'https://demo.invalid', key: 'demo' };
})();
