-- Zsold Portfóliókövető: adatbázis szerkezet és biztonsági szabályok
-- Futtatás: Supabase → SQL Editor → New query → beillesztés → Run

-- ============ Táblák ============

-- Számlák (Excel: Számlák lap)
create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  type text not null default 'Bankszámla',
  ccy text not null default 'HUF',
  opening numeric not null default 0,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

-- Tőzsdei tranzakciók (Excel: Tőzsde lap)
create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date date not null,
  ticker text not null,
  type text not null check (type in ('Vétel','Eladás','Forex','Egyéb')),
  ccy text not null default 'EUR',
  qty numeric not null,
  price numeric not null,
  wht numeric not null default 0,      -- forrásadó
  extra numeric not null default 0,    -- extra költség pénznemben
  account text not null default '',
  created_at timestamptz not null default now()
);

-- Pénzmozgás (Excel: Cashflow lap)
create table if not exists public.cash (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date date not null,
  type text not null check (type in ('Bevétel','Kiadás','Átvezetés')),
  cat text not null default '',
  descr text not null default '',
  acct text not null default '',
  to_acct text not null default '',
  ccy text not null default 'HUF',
  amount numeric not null check (amount > 0),
  created_at timestamptz not null default now()
);

-- Eszközök és aktuális áruk (Excel: Tőzsde aktuál lap)
create table if not exists public.instruments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ticker text not null,
  name text not null default '',
  sector text not null default '',
  ccy text not null default 'EUR',
  price numeric,
  price_at timestamptz,
  source text not null default '',     -- árforrás azonosító (pl. yahoo:VWCE.DE, coingecko:bitcoin)
  unique (user_id, ticker)
);

-- Napi árelőzmények (a frissítő program tölti)
create table if not exists public.price_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  d date not null,
  price numeric not null,
  primary key (user_id, ticker, d)
);

-- MNB árfolyamok (Excel: MNB árfolyam lap) – közös piaci adat
create table if not exists public.fx_rates (
  d date primary key,
  eur numeric,
  usd numeric,
  chf numeric
);

-- Beállítások: kategóriák, NAV adókulcsok
create table if not exists public.settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  categories jsonb not null default '[]',
  tax jsonb not null default '[]'
);

-- ============ Biztonság (Row Level Security) ============
-- Minden saját tábla: csak a bejelentkezett tulajdonos látja és írja a saját sorait.

alter table public.accounts      enable row level security;
alter table public.trades        enable row level security;
alter table public.cash          enable row level security;
alter table public.instruments   enable row level security;
alter table public.price_history enable row level security;
alter table public.fx_rates      enable row level security;
alter table public.settings      enable row level security;

do $$
declare t text;
begin
  foreach t in array array['accounts','trades','cash','instruments','settings'] loop
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('create policy own_rows on public.%I for all to authenticated
                    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;

drop policy if exists own_rows_read on public.price_history;
create policy own_rows_read on public.price_history for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists fx_read on public.fx_rates;
create policy fx_read on public.fx_rates for select to authenticated using (true);

-- Hozzáférés: bejelentkezés nélkül (anon) semmi; bejelentkezve csak a fenti szabályok szerint.
revoke all on public.accounts, public.trades, public.cash, public.instruments,
              public.price_history, public.fx_rates, public.settings from anon;
grant select, insert, update, delete on public.accounts, public.trades, public.cash,
              public.instruments, public.settings to authenticated;
grant select on public.price_history, public.fx_rates to authenticated;
-- price_history és fx_rates írása csak a frissítő programé (service role), a weboldalé nem.
