-- Заглушки схемы auth из Supabase. В боевом проекте Supabase создаёт их сам;
-- здесь нужны, чтобы схема проигрывалась на чистом Postgres в тестах.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
