# CLAUDE.md

Ez a fájl a Zsold repóban dolgozó Claude-nak szól: mi ez a projekt, hogyan épül fel, és milyen szabályok szerint dolgozunk rajta.

## Szabályok (mindig érvényesek)

- **Kommunikáció magyarul, gondolatjel nélkül.** Válaszokban, commit üzenetekben, PR leírásokban és kódkommentekben se használj gondolatjelet (sem „—”, sem „–” mondatközi szerepben). Helyette vessző, pont, zárójel vagy kettőspont.
- **Véleménykérésre csak véleményt adj.** Ha Zsolti azt kérdezi, mit gondolsz valamiről, válaszolj, de ne kezdj el építeni vagy fájlt módosítani kérés nélkül.
- **Feltöltés előtt kérdezz.** Push, PR nyitás, merge, élesítés csak kifejezett engedéllyel. A `main` ágra kerülő változás pár percen belül élesben fut (GitHub Pages).
- **Titkos kulcsok és import SQL-ek soha ne kerüljenek a repóba.** A repó nyilvános. Tilos commitolni: Supabase secret / service_role kulcsot, Alpha Vantage kulcsot, `.env` fájlt, valódi adatokat tartalmazó import SQL-t vagy exportot (tranzakciók, egyenlegek, Excelből átírt sorok). Ezek csak a GitHub Actions titkai között, illetve helyben élhetnek.
  - Kivétel: a `config.js`-ben lévő Supabase **publishable** kulcs szándékosan nyilvános, a védelmet a sorszintű szabályok (RLS) adják.
  - Új tábla esetén mindig legyen RLS és `own_rows` jellegű szabály (lásd `supabase/schema.sql`).

## Mi ez

A Zsold (zsold.app) Zsolti saját pénzügyi és portfóliókövető webappja: kiadás és bevétel követés okos (magyar szöveges) beíróval, számlák, tőzsdei és kripto pozíciók, MNB árfolyamok. Recruitereknek szóló angol bemutató oldala és kitalált adatokkal futó demója is van.

## Címek

| Cím | Fájl | Mi |
|---|---|---|
| `zsold.app/` | `index.html` | Angol bemutató (landing) oldal recruitereknek. Telepített PWA-ként indítva átirányít `/app/`-ra. |
| `zsold.app/app/` | `app/index.html` | A saját app, Supabase belépéssel. Magyar felület. |
| `zsold.app/demo/` | `demo/index.html` | Csak átirányít ide: `/app/?demo`. |
| `zsold.app/app/?demo` | `app/index.html` + `demo-data.js` | Ugyanaz az app, kitalált adatokkal, memóriában futó ál-adatbázissal. |

## Felépítés

- **Hosting:** GitHub Pages a `main` ágról, egyedi domain a `CNAME` fájlban. Nincs build lépés, nincs bundler, nincs `package.json`: minden fájl úgy kerül ki, ahogy a repóban van.
- **Frontend:** egyetlen fájlos, keretrendszer nélküli vanilla JS app (`app/index.html`, inline CSS és JS egy IIFE-ben). A Supabase kliens CDN-ről jön (`@supabase/supabase-js`, rögzített verzió, jsDelivr), betűtípus az Inter (Google Fonts).
- **Adatbázis és belépés:** Supabase (Postgres + Auth). Séma és RLS: `supabase/schema.sql` (kézzel futtatandó a Supabase SQL Editorban).
- **Árfolyamfrissítő:** `scripts/update.mjs` (Node 20, függőség nélkül, csak `fetch`), a `.github/workflows/update.yml` futtatja óránként (7:17 és 22:17 között, nyári idő szerint), kézzel is indítható, és push-ra is fut, ha a script vagy a workflow változik.
  - MNB: hivatalos SOAP webszolgáltatás, EUR/USD/CHF → `fx_rates` (közös tábla). Figyelem: a https végpont SOAP-ra 404-et ad, ezért http.
  - Alpha Vantage: ETF-ek (pl. `VWCE.DEX`, `EQQQ.DEX`). Ingyenes keret, ezért 1,5 mp szünet a kérések között, hétvégén és friss árnál kihagyja.
  - CoinGecko: kripto (pl. `bitcoin`) EUR-ban.
  - Az árak az `instruments` táblába, a napi előzmények a `price_history`-ba kerülnek. Első alkalommal visszamenőleg is tölt (Alpha Vantage kb. 100 nap, CoinGecko 1 év).
  - Titkok (csak Actions secretként): `SUPABASE_SECRET_KEY`, `ALPHAVANTAGE_KEY`. Kulcs nélkül próbaüzemben fut (lekér és kiír, nem ír adatbázisba), így helyben biztonságosan kipróbálható: `node scripts/update.mjs`.
  - A workflow minden futáskor újra engedélyezi magát, mert a GitHub 60 nap tétlenség után leállítaná az időzítést.

## Adatmodell (`supabase/schema.sql`)

`accounts`, `trades`, `cash`, `instruments`, `settings`: felhasználónkénti táblák (`user_id`), a bejelentkezett felhasználó csak a saját sorait látja és írja. `price_history`: felhasználónként olvasható, írni csak a frissítő (service role) írja. `fx_rates`: közös, bejelentkezve olvasható, írni csak a frissítő írja. A táblák az eredeti Excel munkafüzet lapjaira épülnek (a kommentek jelzik, melyikre).

Megjegyzés: az app a `settings` táblába `rules` mezőt is ír (okos beíró szabályai), ez a `schema.sql`-ben még nem szerepel. Ha sémát módosítasz, ezt érdemes rendbe tenni.

## Az app kódja (`app/index.html`)

A szakaszokat `/* ---------- ... ---------- */` kommentek jelölik, sorrendben: helpers, state, FX (MNB), calculations (az Excel munkafüzetből átírt számítások), persistence (Supabase), auth, rendering, okos beíró (helyi magyar szövegelemző), ismétlődő tételek, nézetek (Áttekintés, Portfólió, Pénzmozgás, Számlák, Árfolyamok, Beállítások), charts (kézzel rajzolt SVG grafikonok), sheets (űrlapok), toast, events.

- Állapot: egy központi `S` objektum, a felületi állapot `ui`-ban. Megjelenítés: `render()`, a `schedule()` rAF-fel ütemezi. Mentés után `loadAll()` újratölt mindent.
- Mentés: `put()` / `remove()` a Supabase kliensen keresztül. Az oldal betöltése és a mentés `document.write` nélkül működik; ezt ne hozd vissza (korábban emiatt romlott el a mentés).
- **Összegek elrejtése:** a szem gomb a `HIDE` kapcsolót állítja (localStorage-ban megmarad). Új pénzösszeg megjelenítésénél mindig a formázó függvényeket használd (`huf`, `sHuf`, `money`, `qf`, `compact`), hogy rejtett módban is maszkolva legyen. A piaci ár (`price`) szándékosan nem titkos.
- localStorage kulcs előtag: saját appban `nzterv.`, demóban `zsdemo.`, hogy a kettő ne keveredjen.
- Felhasználói szöveg és felület magyarul (`hu-HU` számformázás). A bemutató oldal (`index.html`) és a demó oldal címe angolul.

## Demó (`demo-data.js`)

Csak `?demo` paraméterrel csinál bármit, egyébként azonnal kilép. Ilyenkor beállítja a `window.ZSOLD_DEMO`-t, lecseréli a `window.supabase.createClient`-et egy memóriában futó utánzatra, és determinisztikus (fix seedű) kitalált adatokat generál a mai naphoz igazítva. Semmi nem megy a valódi adatbázisba, újratöltéskor minden visszaáll. A `demo-data.js`-nek a `config.js` után és az app scriptje előtt kell betöltődnie. Ha az app új Supabase hívást kap, a demó utánzatát is ki kell egészíteni, különben a demó elromlik.

## Dizájn

- Letisztult világos téma, Inter betű, zöld (`#0b5a3b` körül) és lime (`#d9f58c`) hangsúlyok. Az alap CSS után téma rétegek írják felül a `:root` változókat (`/* ===== Zsold téma ... ===== */`, lime hangsúlyok, mozgás).
- **Bordázott zöld háttér:** a nagy zöld kártyákon (az appban a „Nettó vagyon” hero, a bemutató oldalon a hero, a „how” és a záró doboz) `repeating-linear-gradient(90deg, ...)` adja a függőleges bordákat, **40 px-es periódussal**, tiszta, széles bordákkal. Ez a Design-vásznon („Zsold sima háttér”) kiválasztott változat; ne változtasd meg kérés nélkül, és az app és a bemutató oldal maradjon összhangban.
- Mozgás: rövid, `cubic-bezier(.23,1,.32,1)` jellegű ease-out animációk, `prefers-reduced-motion` tisztelete (`REDUCED()`).
- Nagyobb vizuális változtatás előtt előbb Design-vázlat készül, és Zsolti választ.

## Fejlesztés és ellenőrzés

- Helyi futtatás: bármilyen statikus szerver a repó gyökeréből, pl. `python3 -m http.server 8000`, majd `http://localhost:8000/app/?demo` (belépés nélkül a demó a legegyszerűbb tesztkörnyezet). Az abszolút útvonalak (`/config.js`, `/demo-data.js`) miatt a gyökérből kell kiszolgálni.
- Nincs tesztkészlet és linter. Változtatás után nézd meg a demót böngészőben (mobil és asztali szélességen is), és a konzolban ne legyen hiba.
- Frissítő változtatása után: `node scripts/update.mjs` próbaüzemben.
- Statikus fájlok cache-elése: ha ikon vagy kép változik, a `?v=` paramétert léptesd.

## Tervek (tájékoztató)

- Portfólióérték-grafikon időszakválasztóval, visszamenőleg számolva, „ha minden VWCE lett volna” összevetéssel; előbb Design-vázlat.
- Ötletlista: Elemző fül (figyelőlista, SEC EDGAR, makró), Richter-DCF oldal, AI-elemző (API, fizetős).
- LinkedIn-link a bemutató oldalra.
