-- ============================================================================
-- PAREX Campo IAPC — Tabela compartilhada de verificações em campo (Supabase)
-- Projeto: croedunritaqeegbzxus (independente)
-- Segue supabase-postgres-best-practices: tipos adequados, constraints
-- idempotentes, trigger de updated_at, RLS habilitado/forçado e menor privilégio.
-- ============================================================================

create table if not exists public.rnc_verificacoes (
  rnc_codigo text primary key,
  verdict text not null default '',
  checks jsonb not null default '[]'::jsonb,
  gap text not null default '',
  inspector text not null default '',
  visit_date text not null default '',
  field_photos jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- Constraints idempotentes (schema-constraints.md)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_rnc_codigo_formato'
      and conrelid = 'public.rnc_verificacoes'::regclass
  ) then
    alter table public.rnc_verificacoes
      add constraint chk_rnc_codigo_formato
      check (rnc_codigo ~ '^RNC-\d{4,5}/\d{2}$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_rnc_verdict_valido'
      and conrelid = 'public.rnc_verificacoes'::regclass
  ) then
    alter table public.rnc_verificacoes
      add constraint chk_rnc_verdict_valido
      check (verdict in ('', 'ok', 'parcial', 'nao'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_rnc_checks_array'
      and conrelid = 'public.rnc_verificacoes'::regclass
  ) then
    alter table public.rnc_verificacoes
      add constraint chk_rnc_checks_array
      check (jsonb_typeof(checks) = 'array');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_rnc_photos_array_limit'
      and conrelid = 'public.rnc_verificacoes'::regclass
  ) then
    alter table public.rnc_verificacoes
      add constraint chk_rnc_photos_array_limit
      check (
        jsonb_typeof(field_photos) = 'array'
        and jsonb_array_length(field_photos) <= 3
        and octet_length(field_photos::text) <= 450000
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_rnc_text_limits'
      and conrelid = 'public.rnc_verificacoes'::regclass
  ) then
    alter table public.rnc_verificacoes
      add constraint chk_rnc_text_limits
      check (
        char_length(gap) <= 4000
        and char_length(inspector) <= 120
        and char_length(visit_date) <= 20
      );
  end if;
end $$;

-- Índice para sincronização incremental por updated_at
create index if not exists idx_rnc_verificacoes_updated_at
  on public.rnc_verificacoes (updated_at desc);

-- Trigger de timestamp automático no servidor
create or replace function public.fn_set_rnc_verificacoes_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_rnc_verificacoes_updated_at on public.rnc_verificacoes;
create trigger trg_rnc_verificacoes_updated_at
  before insert or update on public.rnc_verificacoes
  for each row
  execute function public.fn_set_rnc_verificacoes_updated_at();

-- Menor privilégio (security-privileges.md): apenas SELECT, INSERT e UPDATE (sem DELETE)
revoke all on table public.rnc_verificacoes from public;
grant select, insert, update on table public.rnc_verificacoes to anon, authenticated;

-- Row Level Security (security-rls-basics.md)
alter table public.rnc_verificacoes enable row level security;
alter table public.rnc_verificacoes force row level security;

drop policy if exists rnc_verificacoes_select_all on public.rnc_verificacoes;
create policy rnc_verificacoes_select_all
  on public.rnc_verificacoes
  for select
  to anon, authenticated
  using (true);

drop policy if exists rnc_verificacoes_insert_valid on public.rnc_verificacoes;
create policy rnc_verificacoes_insert_valid
  on public.rnc_verificacoes
  for insert
  to anon, authenticated
  with check (rnc_codigo ~ '^RNC-\d{4,5}/\d{2}$');

drop policy if exists rnc_verificacoes_update_valid on public.rnc_verificacoes;
create policy rnc_verificacoes_update_valid
  on public.rnc_verificacoes
  for update
  to anon, authenticated
  using (rnc_codigo ~ '^RNC-\d{4,5}/\d{2}$')
  with check (rnc_codigo ~ '^RNC-\d{4,5}/\d{2}$');
