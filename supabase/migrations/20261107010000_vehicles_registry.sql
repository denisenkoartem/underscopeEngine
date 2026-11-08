-- Demo registry: real VINs whose title status a teammate verified by hand
-- (title document, dealer listing or a purchased NMVTIS report).
-- RLS on with NO policies: only the server (service role) can read or write.
-- The public API exposes just title_status, title_state and source for one VIN at a time.

create table public.vehicles (
  vin          text primary key check (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  title_status text not null check (title_status in
                 ('clean', 'salvage', 'rebuilt', 'flood', 'non_repairable', 'lemon')),
  title_state  text check (title_state ~ '^[A-Z]{2}$'),
  odometer     integer check (odometer >= 0),
  source       text not null check (source in ('title_document', 'dealer_listing', 'nmvtis_report')),
  note         text,
  updated_at   timestamptz not null default now()
);

alter table public.vehicles enable row level security;
