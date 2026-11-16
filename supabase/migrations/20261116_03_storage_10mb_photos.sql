-- Bucket público no Supabase Storage com teto de 10 MB por foto (10485760 bytes)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'rnc-campo-fotos',
  'rnc-campo-fotos',
  true,
  10485760,
  array['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Políticas RLS em storage.objects restritas exclusivamente ao bucket rnc-campo-fotos
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'rnc_fotos_public_read'
  ) then
    create policy rnc_fotos_public_read
      on storage.objects
      for select
      to anon, authenticated
      using (bucket_id = 'rnc-campo-fotos');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'rnc_fotos_anon_insert'
  ) then
    create policy rnc_fotos_anon_insert
      on storage.objects
      for insert
      to anon, authenticated
      with check (bucket_id = 'rnc-campo-fotos');
  end if;
end $$;

-- Mantém limite de até 4 fotos na tabela (com URLs leves do Storage ou fallback offline)
alter table public.rnc_verificacoes
  drop constraint if exists chk_rnc_photos_array_limit;

alter table public.rnc_verificacoes
  add constraint chk_rnc_photos_array_limit
  check (
    jsonb_typeof(field_photos) = 'array'
    and jsonb_array_length(field_photos) <= 4
    and octet_length(field_photos::text) <= 1048576
  );
