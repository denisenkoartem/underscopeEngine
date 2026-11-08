-- Allow registry records verified from a public online listing (e.g. Facebook Marketplace).
alter table public.vehicles drop constraint vehicles_source_check;
alter table public.vehicles add constraint vehicles_source_check
  check (source in ('title_document', 'dealer_listing', 'online_listing', 'nmvtis_report'));
