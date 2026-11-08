-- Fault codes module: DTC lookup table and saved scans.
-- RLS: anyone can read dtc_codes and demo scans; only the service role (server) writes.

create table public.dtc_codes (
  code        text primary key check (code ~ '^[PCBU][0-3][0-9A-F]{3}$'),
  description text not null,
  system      text not null check (system in
                ('engine', 'transmission', 'brakes/ABS', 'airbag/SRS', 'electrical', 'emissions', 'body')),
  severity    text not null check (severity in ('minor', 'moderate', 'major', 'critical')),
  cost_low    integer not null check (cost_low >= 0),
  cost_high   integer not null check (cost_high >= cost_low)
);

create table public.scans (
  id         uuid primary key default gen_random_uuid(),
  vin        text not null,
  codes      text[] not null default '{}',
  result     jsonb not null,
  is_demo    boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.dtc_codes enable row level security;
alter table public.scans     enable row level security;

-- Read-only policies. No insert/update/delete policies exist, so only the
-- service role key (which bypasses RLS) can write.
create policy "dtc_codes are public" on public.dtc_codes
  for select to anon, authenticated using (true);

create policy "demo scans are public" on public.scans
  for select to anon, authenticated using (is_demo);
