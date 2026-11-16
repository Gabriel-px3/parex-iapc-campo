-- Atualiza limite de fotos de vistoria por RNC para até 4 fotos (650 KB JSONB)
alter table public.rnc_verificacoes
  drop constraint if exists chk_rnc_photos_array_limit;

alter table public.rnc_verificacoes
  add constraint chk_rnc_photos_array_limit
  check (
    jsonb_typeof(field_photos) = 'array'
    and jsonb_array_length(field_photos) <= 4
    and octet_length(field_photos::text) <= 650000
  );
