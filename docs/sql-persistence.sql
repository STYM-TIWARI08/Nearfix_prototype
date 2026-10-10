-- NearFix Supabase schema. Apply once in Supabase SQL Editor as project owner.
-- Public clients use the anon key. The service-role key is backend-only.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'customer' check (role in ('customer','technician','admin')),
  full_name text not null check (length(trim(full_name)) between 1 and 120),
  email text not null,
  phone text,
  area text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.technician_profiles (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  display_name text not null,
  service text not null,
  bio text not null default '',
  years_experience integer not null default 0 check (years_experience >= 0),
  price_from numeric(10,2) check (price_from is null or price_from >= 0),
  available boolean not null default false,
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.technician_skills (
  id bigint generated always as identity primary key,
  technician_id uuid not null references public.technician_profiles(user_id) on delete cascade,
  skill text not null check (length(trim(skill)) between 1 and 100),
  unique (technician_id, skill)
);

create table if not exists public.technician_service_areas (
  id bigint generated always as identity primary key,
  technician_id uuid not null references public.technician_profiles(user_id) on delete cascade,
  area text not null check (length(trim(area)) between 1 and 160),
  unique (technician_id, area)
);

create table if not exists public.technician_availability (
  id bigint generated always as identity primary key,
  technician_id uuid not null references public.technician_profiles(user_id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  starts_at time not null,
  ends_at time not null,
  check (starts_at < ends_at),
  unique (technician_id, weekday, starts_at, ends_at)
);

create table if not exists public.service_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete restrict,
  service text not null,
  description text not null check (length(trim(description)) between 1 and 4000),
  location text not null,
  requested_for timestamptz,
  status text not null default 'REQUESTED' check (status in ('REQUESTED','ASSIGNED','ACCEPTED','ON_THE_WAY','ARRIVED','INSPECTION','AWAITING_APPROVAL','IN_PROGRESS','COMPLETED','CANCELLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.technician_assignments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.service_requests(id) on delete cascade,
  technician_id uuid not null references public.technician_profiles(user_id) on delete restrict,
  status text not null default 'OFFERED' check (status in ('OFFERED','ACCEPTED','REJECTED','ACTIVE','COMPLETED','CANCELLED')),
  offered_at timestamptz not null default now(),
  responded_at timestamptz,
  unique (request_id, technician_id)
);

create table if not exists public.service_history (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.service_requests(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  status text not null check (status in ('REQUESTED','ASSIGNED','ACCEPTED','ON_THE_WAY','ARRIVED','INSPECTION','AWAITING_APPROVAL','IN_PROGRESS','COMPLETED','CANCELLED')),
  note text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists technician_profiles_service_idx on public.technician_profiles(service);
create unique index if not exists profiles_email_lower_idx on public.profiles(lower(email));
create index if not exists technician_profiles_available_idx on public.technician_profiles(available) where available;
create index if not exists technician_service_areas_area_idx on public.technician_service_areas(area);
create index if not exists service_requests_customer_created_idx on public.service_requests(customer_id, created_at desc);
create index if not exists service_requests_status_created_idx on public.service_requests(status, created_at desc);
create index if not exists technician_assignments_tech_status_idx on public.technician_assignments(technician_id, status);
create index if not exists service_history_request_created_idx on public.service_history(request_id, created_at);

-- Private compatibility store for the existing API model. It is never exposed
-- to anon/authenticated clients. See README for the normalized migration status.
create table if not exists public.nearfix_state (
  id integer primary key check (id = 1),
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create or replace function public.nearfix_is_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin');
$$;

create or replace function public.nearfix_can_access_request(request_uuid uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.service_requests r
    where r.id = request_uuid and (
      r.customer_id = auth.uid() or public.nearfix_is_admin() or exists (
        select 1 from public.technician_assignments a
        where a.request_id = r.id and a.technician_id = auth.uid()
      )
    )
  );
$$;

create or replace function public.nearfix_create_profile()
returns trigger language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  safe_role text;
  profile_name text;
begin
  -- Signup metadata can request a customer or technician account only.
  safe_role := case when new.raw_user_meta_data->>'role' = 'technician' then 'technician' else 'customer' end;
  profile_name := coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), split_part(coalesce(new.email, ''), '@', 1));
  insert into public.profiles(id, role, full_name, email, phone, area)
  values (new.id, safe_role, profile_name, coalesce(new.email,''), nullif(new.raw_user_meta_data->>'phone',''), nullif(new.raw_user_meta_data->>'area',''))
  on conflict (id) do nothing;
  if safe_role = 'technician' then
    insert into public.technician_profiles(user_id, display_name, service)
    values (new.id, profile_name, coalesce(nullif(new.raw_user_meta_data->>'service',''), 'General Repair'))
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

create or replace function public.nearfix_touch_updated_at()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists nearfix_profiles_updated_at on public.profiles;
create trigger nearfix_profiles_updated_at before update on public.profiles
for each row execute function public.nearfix_touch_updated_at();
drop trigger if exists nearfix_technician_profiles_updated_at on public.technician_profiles;
create trigger nearfix_technician_profiles_updated_at before update on public.technician_profiles
for each row execute function public.nearfix_touch_updated_at();
drop trigger if exists nearfix_service_requests_updated_at on public.service_requests;
create trigger nearfix_service_requests_updated_at before update on public.service_requests
for each row execute function public.nearfix_touch_updated_at();

drop trigger if exists nearfix_auth_user_created on auth.users;
create trigger nearfix_auth_user_created after insert on auth.users
for each row execute function public.nearfix_create_profile();

alter table public.profiles enable row level security;
alter table public.technician_profiles enable row level security;
alter table public.technician_skills enable row level security;
alter table public.technician_service_areas enable row level security;
alter table public.technician_availability enable row level security;
alter table public.service_requests enable row level security;
alter table public.technician_assignments enable row level security;
alter table public.service_history enable row level security;
alter table public.nearfix_state enable row level security;

revoke all on public.profiles, public.technician_profiles, public.technician_skills,
  public.technician_service_areas, public.technician_availability,
  public.service_requests, public.technician_assignments, public.service_history,
  public.nearfix_state from anon, authenticated;

grant select on public.profiles to authenticated;
-- area also carries admin scope; only the service-role backend/project owner may change it.
grant update (full_name, phone) on public.profiles to authenticated;
grant select on public.technician_profiles, public.technician_skills,
  public.technician_service_areas, public.technician_availability to authenticated;
grant insert (user_id, display_name, service, bio, years_experience, price_from, available)
  on public.technician_profiles to authenticated;
grant update (display_name, service, bio, years_experience, price_from, available)
  on public.technician_profiles to authenticated;
grant delete on public.technician_profiles to authenticated;
grant insert, update, delete on public.technician_skills,
  public.technician_service_areas, public.technician_availability to authenticated;
grant select, insert on public.service_requests to authenticated;
grant select on public.technician_assignments, public.service_history to authenticated;

create policy profiles_read_self_or_admin on public.profiles for select to authenticated
  using (id = auth.uid() or public.nearfix_is_admin());
create policy profiles_update_self_or_admin on public.profiles for update to authenticated
  using (id = auth.uid() or public.nearfix_is_admin())
  with check (id = auth.uid() or public.nearfix_is_admin());

create policy technician_profiles_read on public.technician_profiles for select to authenticated
  using (verified = true or user_id = auth.uid() or public.nearfix_is_admin() or exists (
    select 1 from public.service_requests r join public.technician_assignments a on a.request_id = r.id
    where a.technician_id = technician_profiles.user_id and r.customer_id = auth.uid()
  ));
create policy technician_profiles_update_self_or_admin on public.technician_profiles for update to authenticated
  using (user_id = auth.uid() or public.nearfix_is_admin()) with check (user_id = auth.uid() or public.nearfix_is_admin());
create policy technician_profiles_insert_self on public.technician_profiles for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'technician'));
create policy technician_profiles_delete_admin on public.technician_profiles for delete to authenticated
  using (public.nearfix_is_admin());

create policy technician_skills_read on public.technician_skills for select to authenticated
  using (technician_id = auth.uid() or public.nearfix_is_admin() or exists (select 1 from public.technician_profiles t where t.user_id = technician_skills.technician_id and t.verified));
create policy technician_skills_manage_self_or_admin on public.technician_skills for all to authenticated
  using (technician_id = auth.uid() or public.nearfix_is_admin()) with check (technician_id = auth.uid() or public.nearfix_is_admin());
create policy technician_service_areas_read on public.technician_service_areas for select to authenticated
  using (technician_id = auth.uid() or public.nearfix_is_admin() or exists (select 1 from public.technician_profiles t where t.user_id = technician_service_areas.technician_id and t.verified));
create policy technician_service_areas_manage_self_or_admin on public.technician_service_areas for all to authenticated
  using (technician_id = auth.uid() or public.nearfix_is_admin()) with check (technician_id = auth.uid() or public.nearfix_is_admin());
create policy technician_availability_read on public.technician_availability for select to authenticated
  using (technician_id = auth.uid() or public.nearfix_is_admin() or exists (select 1 from public.technician_profiles t where t.user_id = technician_availability.technician_id and t.verified));
create policy technician_availability_manage_self_or_admin on public.technician_availability for all to authenticated
  using (technician_id = auth.uid() or public.nearfix_is_admin()) with check (technician_id = auth.uid() or public.nearfix_is_admin());

create policy requests_read_owner_assigned_admin on public.service_requests for select to authenticated
  using (customer_id = auth.uid() or public.nearfix_is_admin() or public.nearfix_can_access_request(id));
create policy requests_create_self on public.service_requests for insert to authenticated
  with check (customer_id = auth.uid() and status = 'REQUESTED');

create policy assignments_read_participants_admin on public.technician_assignments for select to authenticated
  using (technician_id = auth.uid() or public.nearfix_is_admin() or public.nearfix_can_access_request(request_id));
create policy service_history_read_participants_admin on public.service_history for select to authenticated
  using (public.nearfix_can_access_request(request_id) or public.nearfix_is_admin());

-- Admin promotion is intentionally not granted to browser roles. The project
-- owner provisions an admin after the user verifies their email, with SQL:
-- update public.profiles set role='admin' where email=lower('verified-admin@example.com');
