// Zsold árfolyamfrissítő: MNB devizaárfolyamok + eszközárak → Supabase.
// GitHub Actions futtatja (lásd .github/workflows/update.yml).
// SUPABASE_SECRET_KEY nélkül próbaüzemben fut: lekér és kiír, de nem ír adatbázisba.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ykbxsqtgrpmfpknwopqe.supabase.co';
const KEY = process.env.SUPABASE_SECRET_KEY || '';
const DRY = !KEY || process.env.DRY_RUN === 'true';
const UA = 'Zsold-portfolio-tracker/1.0 (personal use; github.com/nagyzsolesz06-sys/zsold)';

// Alapértelmezett árforrások tickerenként (az eszköz "source" mezője felülírja).
const DEFAULT_SOURCES = {
  'VWCE': 'stooq:vwce.de',
  'EQQQ': 'stooq:eqqq.de',
  'BTC/EUR': 'coingecko:bitcoin',
};

const GH = !!process.env.GITHUB_ACTIONS;
const fmt = a => a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
const log = (...a) => console.log(fmt(a));
const note = (...a) => console.log(GH ? `::notice::${fmt(a)}` : fmt(a)); // a GitHub felületén is látszik
const iso = d => d.toISOString().slice(0, 10);
const daysAgo = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return iso(d); };

/* ---------- Supabase REST ---------- */
function sbHeaders(extra = {}) {
  const h = { apikey: KEY, 'Content-Type': 'application/json', ...extra };
  if (!KEY.startsWith('sb_')) h.Authorization = `Bearer ${KEY}`; // régi (JWT) service_role kulcs
  return h;
}
async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbUpsert(table, rows, onConflict) {
  if (!rows.length) return;
  if (DRY) { log(`  [próba] ${table}: ${rows.length} sor írása kihagyva`); return; }
  const q = onConflict ? `?on_conflict=${onConflict}` : '';
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${q}`, {
    method: 'POST', headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`UPSERT ${table}: ${r.status} ${await r.text()}`);
}
async function sbPatch(table, filter, body) {
  if (DRY) return;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${table}: ${r.status} ${await r.text()}`);
}

/* ---------- MNB (hivatalos webszolgáltatás) ---------- */
async function mnbRates(start, end) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:web="http://www.mnb.hu/webservices/">
  <soap:Body><web:GetExchangeRates><web:startDate>${start}</web:startDate><web:endDate>${end}</web:endDate><web:currencyNames>EUR,USD,CHF</web:currencyNames></web:GetExchangeRates></soap:Body>
</soap:Envelope>`;
  const r = await fetch('https://www.mnb.hu/arfolyamok.asmx', {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"http://www.mnb.hu/webservices/MNBArfolyamServiceSoap/GetExchangeRates"', 'User-Agent': UA },
    body,
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`MNB ${r.status}: ${txt.slice(0, 300)}`);
  const inner = (txt.match(/<GetExchangeRatesResult>([\s\S]*?)<\/GetExchangeRatesResult>/) || [])[1] || '';
  const xml = inner.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const rows = [];
  for (const day of xml.matchAll(/<Day date="(\d{4}-\d{2}-\d{2})">([\s\S]*?)<\/Day>/g)) {
    const row = { d: day[1] };
    for (const rate of day[2].matchAll(/<Rate unit="(\d+)" curr="([A-Z]{3})">([\d.,]+)<\/Rate>/g)) {
      row[rate[2].toLowerCase()] = Number(rate[3].replace(',', '.')) / Number(rate[1]);
    }
    rows.push(row);
  }
  return rows;
}

/* ---------- Árforrások ---------- */
function parseCsv(txt) {
  const lines = txt.trim().split(/\r?\n/); const head = lines.shift().split(',');
  return lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [head[i], v])));
}
async function stooqQuote(sym) {
  const r = await fetch(`https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`, { headers: { 'User-Agent': UA } });
  const rows = parseCsv(await r.text()); const row = rows[0] || {};
  const p = Number(row.Close);
  if (!r.ok || !isFinite(p) || p <= 0) throw new Error(`Stooq ${sym}: nincs ár (${JSON.stringify(row)})`);
  return { price: p, date: row.Date };
}
async function stooqHistory(sym, since) {
  const r = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&d1=${since.replace(/-/g, '')}&i=d`, { headers: { 'User-Agent': UA } });
  const txt = await r.text();
  if (!r.ok || !/^Date,/.test(txt)) throw new Error(`Stooq előzmény ${sym}: ${txt.slice(0, 120)}`);
  return parseCsv(txt).map(x => ({ d: x.Date, price: Number(x.Close) })).filter(x => x.price > 0);
}
async function coingeckoQuote(id) {
  const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=eur&include_last_updated_at=true`, { headers: { 'User-Agent': UA, accept: 'application/json' } });
  const j = await r.json(); const p = j?.[id]?.eur;
  if (!r.ok || !(p > 0)) throw new Error(`CoinGecko ${id}: ${JSON.stringify(j).slice(0, 200)}`);
  return { price: p, date: iso(new Date((j[id].last_updated_at || Date.now() / 1000) * 1000)) };
}
async function coingeckoHistory(id) {
  const r = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=eur&days=365&interval=daily`, { headers: { 'User-Agent': UA, accept: 'application/json' } });
  const j = await r.json();
  if (!r.ok || !Array.isArray(j.prices)) throw new Error(`CoinGecko előzmény ${id}: ${JSON.stringify(j).slice(0, 200)}`);
  const byDay = new Map(); j.prices.forEach(([t, p]) => byDay.set(iso(new Date(t)), p));
  return [...byDay].map(([d, price]) => ({ d, price }));
}
const quote = src => { const [k, v] = src.split(':'); return k === 'stooq' ? stooqQuote(v) : k === 'coingecko' ? coingeckoQuote(v) : Promise.reject(new Error('ismeretlen forrás: ' + src)); };
const history = (src, since) => { const [k, v] = src.split(':'); return k === 'stooq' ? stooqHistory(v, since) : coingeckoHistory(v); };
const resolveSource = inst => (inst.source && !inst.source.startsWith('yahoo:')) ? inst.source : DEFAULT_SOURCES[inst.ticker] || '';

/* ---------- Futás ---------- */
let failures = 0;
async function step(name, fn) {
  try { await fn(); } catch (e) { failures++; console.log(GH ? `::error::${name}: ${e.message}` : `✗ ${name}: ${e.message}`); }
}

log(DRY ? '— Próbaüzem (nincs adatbázis-írás) —' : '— Éles futás —');

await step('MNB', async () => {
  let start = daysAgo(10);
  if (!DRY) { const last = await sbGet('fx_rates?select=d&order=d.desc&limit=1'); if (last[0]) start = last[0].d; }
  const rows = await mnbRates(start, iso(new Date()));
  note(`✓ MNB: ${rows.length} nap ${start} óta`, rows.slice(-1)[0] || '');
  await sbUpsert('fx_rates', rows, 'd');
});

const instruments = DRY
  ? Object.keys(DEFAULT_SOURCES).map(ticker => ({ ticker, source: '', user_id: null }))
  : await sbGet('instruments?select=id,user_id,ticker,source,price_at');

for (const inst of instruments) {
  const src = resolveSource(inst);
  if (!src) { log(`– ${inst.ticker}: nincs árforrás beállítva, kihagyva`); continue; }
  await step(inst.ticker, async () => {
    const q = await quote(src);
    note(`✓ ${inst.ticker} (${src}): ${q.price} @ ${q.date}`);
    await sbPatch('instruments', `id=eq.${inst.id}`, { price: q.price, price_at: new Date().toISOString(), source: src });
    // Előzmények: első alkalommal visszamenőleg (Stooq 5 év, CoinGecko 1 év), utána csak a mai nap.
    let hist = [{ d: q.date, price: q.price }];
    const have = DRY ? [] : await sbGet(`price_history?select=d&user_id=eq.${inst.user_id}&ticker=eq.${encodeURIComponent(inst.ticker)}&limit=40`);
    if (have.length < 30) {
      try { const h = await history(src, daysAgo(5 * 365)); note(`${inst.ticker}: ${h.length} napos előzmény`); hist = h.concat(hist); }
      catch (e) { note(`${inst.ticker}: előzmény nem érhető el (${e.message})`); }
    }
    const uniq = new Map(hist.map(x => [x.d, x]));
    await sbUpsert('price_history', [...uniq.values()].map(x => ({ user_id: inst.user_id, ticker: inst.ticker, d: x.d, price: x.price })), 'user_id,ticker,d');
  });
}

log(failures ? `Kész, ${failures} hibával.` : 'Kész.');
if (failures) process.exitCode = 1;
