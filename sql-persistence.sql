-- NearFix persistent PostgreSQL storage (Supabase)
-- Run this once in Supabase SQL Editor.
-- The application stores the complete NearFix state in JSONB so the existing
-- customer/technician/admin data model and UI do not need to be rewritten.
create table if not exists public.nearfix_state (
  id integer primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists nearfix_state_updated_at_idx
  on public.nearfix_state(updated_at desc);

-- Keep this table private. The NearFix backend uses the Supabase service-role
-- key and talks to it through the REST API. Do not expose service-role access
-- to browser/client code.
-- Passwords are salted scrypt hashes before they are written to the state.
