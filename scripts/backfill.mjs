// Zsold árelőzmény-visszatöltő: régi eszközárak a portfólióérték-grafikonhoz → Supabase price_history.
// Kézzel indítható (Actions → Árfolyamfrissítés → Run workflow → mód: visszatöltés), nem fut óránként.
//
// Mit tölt:
//  - minden felhasználónak minden olyan eszközre, amiből volt tranzakciója, az első vételétől máig,
//  - és a VWCE-re akkor is, ha nincs belőle, mert a "ha minden VWCE lett volna" összevetéshez kell.
// Honnan:
//  - ETF-ek: Alpha Vantage heti záróár (TIME_SERIES_WEEKLY, 20+ év) és napi záróár az utolsó kb. 100 napra,
//  - kripto: CoinGecko napi ár 1 évre, régebbre a Kraken nyilvános OHLC végpontja (napi kb. 2 év, heti több).
// A meglévő sorokat nem írja felül (a napi árak pontosabbak a hetinél), csak a hiányzó napokat pótolja.
//
// SUPABASE_SECRET_KEY nélkül vagy DRY_RUN=true mellett próbaüzem: lekér és kiírja, mit kapott, de nem ír.
// A napló nyilvános, ezért csak piaci adat kerül bele, a tranzakciók dátuma és darabszáma nem.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ykbxsqtgrpmfpknwopqe.supabase.co';
const KEY = process.env.SUPABASE_SECRET_KEY || '';
const AV_KEY = process.env.ALPHAVANTAGE_KEY || '';
const DRY = !KEY || process.env.DRY_RUN === 'true';
const UA = 'Zsold-portfolio-tracker/1.0 (personal use; github.com/nagyzsolesz06-sys/zsold)';
const BENCH = 'VWCE'; // az összevetés alapja

// Ugyanaz a táblázat, mint a scripts/update.mjs-ben.
const DEFAULT_SOURCES = {
  'VWCE': 'alphavantage:VWCE.DEX',
  'EQQQ': 'alphavantage:EQQQ.DEX',
  'BTC/EUR': 'coingecko:bitcoin',
};
// CoinGecko azonosító → Kraken devizapár (csak a régi kriptoárakhoz).
const KRAKEN_PAIRS = { bitcoin: 'XBTEUR', ethereum: 'ETHEUR' };

const GH = !!process.env.GITHUB_ACTIONS;
const fmt = a => a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
const log = (...a) => console.log(fmt(a));
const note = (...a) => console.log(GH ? `::notice::${fmt(a)}` : fmt(a));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = d => d.toISOString().slice(0, 10);
const daysAgo = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return iso(d); };
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const span = rows => rows.length ? `${rows.length} sor, ${rows[0].d} és ${rows[rows.length - 1].d} között` : 'nincs adat';
const sortRows = rows => rows.filter(x => x.price > 0 && /^\d{4}-\d{2}-\d{2}$/.test(x.d)).sort((a, b) => a.d < b.d ? -1 : 1);

/* ---------- Supabase REST ---------- */
function sbHeaders(extra = {}) {
  const h = { apikey: KEY, 'Content-Type': 'application/json', ...extra };
  if (!KEY.startsWith('sb_')) h.Authorization = `Bearer ${KEY}`;
  return h;
}
async function sbGetAll(path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders({ Range: `${from}-${from + 999}`, 'Range-Unit': 'items' }) });
    if (!r.ok) throw new Error(`GET ${path.split('?')[0]}: ${r.status} ${await r.text()}`);
    const rows = await r.json(); out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
async function sbInsertMissing(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += 500) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: 'POST', headers: sbHeaders({ Prefer: 'resolution=ignore-duplicates,return=minimal' }), body: JSON.stringify(rows.slice(i, i + 500)),
    });
    if (!r.ok) throw new Error(`INSERT ${table}: ${r.status} ${await r.text()}`);
  }
}

/* ---------- Árforrások ---------- */
let avLast = 0;
async function av(fn, sym, extra = '') {
  if (!AV_KEY) throw new Error('nincs ALPHAVANTAGE_KEY titok beállítva');
  const wait = 1600 - (Date.now() - avLast); if (wait > 0) await sleep(wait); // ingyenes keret: max. 1 kérés/másodperc
  avLast = Date.now();
  const r = await fetch(`https://www.alphavantage.co/query?function=${fn}&symbol=${encodeURIComponent(sym)}${extra}&apikey=${AV_KEY}`, { headers: { 'User-Agent': UA } });
  const j = await r.json();
  const key = Object.keys(j).find(k => /Time Series/i.test(k));
  if (!r.ok || !key) throw new Error(`Alpha Vantage ${fn} ${sym}: ${JSON.stringify(j).slice(0, 200)}`);
  return sortRows(Object.entries(j[key]).map(([d, v]) => ({ d, price: Number(v['4. close']) })));
}
const avWeekly = sym => av('TIME_SERIES_WEEKLY', sym);
const avDaily = sym => av('TIME_SERIES_DAILY', sym, '&outputsize=compact');

async function coingeckoDaily(id) {
  const r = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=eur&days=365&interval=daily`, { headers: { 'User-Agent': UA, accept: 'application/json' } });
  const j = await r.json();
  if (!r.ok || !Array.isArray(j.prices)) throw new Error(`CoinGecko ${id}: ${JSON.stringify(j).slice(0, 200)}`);
  const byDay = new Map(); j.prices.forEach(([t, p]) => byDay.set(iso(new Date(t)), p));
  return sortRows([...byDay].map(([d, price]) => ({ d, price })));
}
// Kraken OHLC: [idő, nyitó, max, min, záró, ...], legfeljebb 720 gyertya. Az utolsó gyertya még nem zárt le, azt kihagyjuk.
async function krakenOhlc(pair, minutes) {
  const r = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${minutes}`, { headers: { 'User-Agent': UA, accept: 'application/json' } });
  const j = await r.json();
  const key = j.result && Object.keys(j.result).find(k => k !== 'last');
  if (!r.ok || (j.error && j.error.length) || !key) throw new Error(`Kraken ${pair}: ${JSON.stringify(j.error || j).slice(0, 200)}`);
  const days = minutes / 1440;
  // A záróár a gyertya utolsó napjához tartozik.
  return sortRows(j.result[key].slice(0, -1).map(c => ({ d: addDays(iso(new Date(c[0] * 1000)), days - 1), price: Number(c[4]) })));
}

// Egy forrás teljes elérhető előzménye `since` óta: a heti sorokra ráírjuk a pontosabb napiakat.
const cache = new Map();
async function series(src, since) {
  if (cache.has(src)) return cache.get(src);
  const [kind, id] = src.split(':'); const byDay = new Map(); const parts = [];
  const take = async (label, fn) => {
    try { const rows = await fn(); rows.forEach(x => byDay.set(x.d, x.price)); parts.push(`${label}: ${span(rows)}`); return rows; }
    catch (e) { failures++; console.log(GH ? `::error::${src} ${label}: ${e.message}` : `✗ ${src} ${label}: ${e.message}`); return []; }
  };
  if (kind === 'alphavantage') {
    await take('heti', () => avWeekly(id));
    await take('napi', () => avDaily(id));
  } else if (kind === 'coingecko') {
    const pair = KRAKEN_PAIRS[id];
    if (since < daysAgo(360) && pair) {
      await take('Kraken heti', () => krakenOhlc(pair, 10080));
      await take('Kraken napi', () => krakenOhlc(pair, 1440));
    }
    await take('CoinGecko napi', () => coingeckoDaily(id));
  } else { log(`– ${src}: ismeretlen forrás, kihagyva`); }
  const rows = sortRows([...byDay].map(([d, price]) => ({ d, price })));
  note(`${src} → ${parts.join(' · ') || 'nincs adat'}`);
  cache.set(src, rows); return rows;
}

/* ---------- Futás ---------- */
let failures = 0;
log(DRY ? '— Visszatöltés próbaüzemben (nincs adatbázis-írás) —' : '— Visszatöltés, éles futás —');

// Kinek, mire, mióta kell ár.
const jobs = []; // { user_id, ticker, src, since }
if (KEY) {
  const [instruments, trades] = await Promise.all([
    sbGetAll('instruments?select=user_id,ticker,source'),
    sbGetAll('trades?select=user_id,ticker,date,type&type=in.(V%C3%A9tel,Elad%C3%A1s)&order=date.asc'),
  ]);
  const users = new Map(); // user_id → { first, tickers: Map(ticker → első dátum) }
  for (const t of trades) {
    const tk = String(t.ticker || '').trim().toUpperCase(); if (!tk || !t.date) continue;
    if (!users.has(t.user_id)) users.set(t.user_id, { first: t.date, tickers: new Map() });
    const u = users.get(t.user_id);
    if (t.date < u.first) u.first = t.date;
    if (!u.tickers.has(tk) || t.date < u.tickers.get(tk)) u.tickers.set(tk, t.date);
  }
  for (const [user_id, u] of users) {
    u.tickers.set(BENCH, u.first); // az összevetéshez az első vétel napjától kell
    for (const [ticker, first] of u.tickers) {
      const inst = instruments.find(i => i.user_id === user_id && String(i.ticker).trim().toUpperCase() === ticker);
      const own = inst && inst.source && !/^(yahoo|stooq|demo):/.test(inst.source) ? inst.source : '';
      const src = own || DEFAULT_SOURCES[ticker] || '';
      if (!src) { log(`– ${ticker}: nincs árforrás beállítva, kihagyva`); continue; }
      jobs.push({ user_id, ticker, src, since: addDays(first, -10) }); // pár nap ráhagyás, hogy az első vétel napjára is legyen előző ismert ár
    }
  }
  log(`${users.size} felhasználó, ${jobs.length} eszköz-sorozat`);
} else {
  // Kulcs nélkül: csak azt nézzük meg, mit adnak a források az alapértelmezett eszközökre.
  for (const [ticker, src] of Object.entries(DEFAULT_SOURCES)) jobs.push({ user_id: null, ticker, src, since: daysAgo(3 * 365) });
}

let written = 0, short = 0;
for (const job of jobs) {
  // Ha több felhasználónak kell ugyanaz a forrás, a legrégebbi igény szerint kérjük le egyszer.
  const oldest = jobs.filter(j => j.src === job.src).reduce((m, j) => j.since < m ? j.since : m, job.since);
  const all = await series(job.src, oldest);
  const rows = all.filter(x => x.d >= job.since);
  if (!rows.length) { short++; continue; }
  if (rows[0].d > addDays(job.since, 21)) { short++; note(`${job.ticker}: a forrás nem ér vissza az első vételig, a grafikon eleje hiányos lesz`); }
  if (DRY) { log(`  [próba] ${job.ticker}: írás kihagyva`); continue; }
  try { await sbInsertMissing('price_history', rows.map(x => ({ user_id: job.user_id, ticker: job.ticker, d: x.d, price: x.price })), 'user_id,ticker,d'); written++; }
  catch (e) { failures++; console.log(GH ? `::error::${job.ticker}: ${e.message}` : `✗ ${job.ticker}: ${e.message}`); }
}

note(DRY ? `Próba kész: ${jobs.length - short}/${jobs.length} sorozat fedi a szükséges időszakot.` : `Kész: ${written}/${jobs.length} sorozat kiírva${short ? `, ${short} hiányos` : ''}.`);
if (failures) { log(`${failures} hiba történt.`); process.exitCode = 1; }
