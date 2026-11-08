-- Market values for registry vehicles (CLAUDE.md "As-is band"): hand-entered per vehicle.
alter table public.vehicles
  add column clean_wholesale integer check (clean_wholesale > 0),
  add column salvage_comps   integer[] check (cardinality(salvage_comps) <= 20),
  add column values_note     text;
