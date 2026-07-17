-- Lernzeit: private Gruppen mit maximal zehn Mitgliedern
-- Diese Datei einmal vollständig im Supabase SQL Editor ausführen.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 30),
  created_at timestamptz not null default now()
);

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 40),
  invite_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  max_members smallint not null default 10 check (max_members between 2 and 10),
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  entry_date date not null,
  category text not null check (category in ('studium', 'arbeit', 'persoenlich', 'sonstiges')),
  minutes integer not null check (minutes between 1 and 1439),
  topic text not null default '' check (char_length(topic) <= 80),
  visibility text not null default 'private' check (visibility in ('group', 'private')),
  created_at timestamptz not null default now()
);

create index if not exists entries_user_date_idx on public.entries(user_id, entry_date desc);
create index if not exists group_members_group_idx on public.group_members(group_id);

-- Erlaubt ein erneutes Ausführen dieses Schemas bei bereits angelegten Projekten.
alter table public.groups drop constraint if exists groups_max_members_check;
alter table public.groups alter column max_members set default 10;
update public.groups set max_members = 10 where max_members < 10;
alter table public.groups
  add constraint groups_max_members_check check (max_members between 2 and 10);

alter table public.group_members drop constraint if exists group_members_role_check;
alter table public.group_members
  add constraint group_members_role_check check (role in ('owner', 'admin', 'member'));

create or replace function public.is_group_member(target_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.group_members
    where group_id = target_group_id and user_id = (select auth.uid())
  );
$$;

create or replace function public.shares_group_with(other_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.group_members mine
    join public.group_members theirs on theirs.group_id = mine.group_id
    where mine.user_id = (select auth.uid()) and theirs.user_id = other_user_id
  );
$$;

create or replace function public.is_group_admin_for_user(other_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.group_members administrator
    join public.group_members target on target.group_id = administrator.group_id
    where administrator.user_id = (select auth.uid())
      and administrator.role in ('owner', 'admin')
      and target.user_id = other_user_id
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.create_private_group(group_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_group_id uuid;
  cleaned_name text := trim(group_name);
begin
  if (select auth.uid()) is null then
    raise exception 'Du musst angemeldet sein.';
  end if;
  if char_length(cleaned_name) < 2 or char_length(cleaned_name) > 40 then
    raise exception 'Der Gruppenname muss 2 bis 40 Zeichen lang sein.';
  end if;
  if exists (select 1 from public.group_members where user_id = (select auth.uid())) then
    raise exception 'Du bist bereits Mitglied einer Gruppe.';
  end if;

  insert into public.groups (name, owner_id)
  values (cleaned_name, (select auth.uid()))
  returning id into new_group_id;

  insert into public.group_members (group_id, user_id, role)
  values (new_group_id, (select auth.uid()), 'owner');
  return new_group_id;
end;
$$;

create or replace function public.join_private_group(invitation_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_group public.groups%rowtype;
  current_size integer;
begin
  if (select auth.uid()) is null then
    raise exception 'Du musst angemeldet sein.';
  end if;
  if exists (select 1 from public.group_members where user_id = (select auth.uid())) then
    raise exception 'Du bist bereits Mitglied einer Gruppe.';
  end if;

  select * into target_group
  from public.groups
  where invite_code = upper(trim(invitation_code))
  for update;

  if target_group.id is null then
    raise exception 'Der Einladungs-Code ist ungültig.';
  end if;

  select count(*) into current_size
  from public.group_members
  where group_id = target_group.id;

  if current_size >= target_group.max_members then
    raise exception 'Diese Gruppe hat bereits zehn Mitglieder.';
  end if;

  insert into public.group_members (group_id, user_id, role)
  values (target_group.id, (select auth.uid()), 'member');
  return target_group.id;
end;
$$;

create or replace function public.get_group_invite_code()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result text;
begin
  select groups.invite_code into result
  from public.groups
  join public.group_members on group_members.group_id = groups.id
  where group_members.user_id = (select auth.uid())
    and group_members.role in ('owner', 'admin');

  if result is null then
    raise exception 'Nur Admins dürfen den Einladungs-Code sehen.';
  end if;
  return result;
end;
$$;

create or replace function public.set_group_member_role(target_user_id uuid, new_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  owners_group_id uuid;
  target_role text;
begin
  if new_role not in ('admin', 'member') then
    raise exception 'Diese Rolle ist nicht erlaubt.';
  end if;

  select group_id into owners_group_id
  from public.group_members
  where user_id = (select auth.uid()) and role = 'owner';

  if owners_group_id is null then
    raise exception 'Nur der Hauptadmin darf Rollen vergeben.';
  end if;

  select role into target_role
  from public.group_members
  where group_id = owners_group_id and user_id = target_user_id;

  if target_role is null then
    raise exception 'Dieses Konto gehört nicht zu deiner Gruppe.';
  end if;
  if target_role = 'owner' then
    raise exception 'Die Rolle des Hauptadmins kann nicht geändert werden.';
  end if;

  update public.group_members
  set role = new_role
  where group_id = owners_group_id and user_id = target_user_id;
end;
$$;

create or replace function public.remove_group_member(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  managers_group_id uuid;
  managers_role text;
  target_role text;
begin
  select group_id, role into managers_group_id, managers_role
  from public.group_members
  where user_id = (select auth.uid()) and role in ('owner', 'admin');

  if managers_group_id is null then
    raise exception 'Du darfst keine Mitglieder entfernen.';
  end if;

  select role into target_role
  from public.group_members
  where group_id = managers_group_id and user_id = target_user_id;

  if target_role is null then
    raise exception 'Dieses Konto gehört nicht zu deiner Gruppe.';
  end if;
  if target_role = 'owner' or (managers_role = 'admin' and target_role = 'admin') then
    raise exception 'Dieses Mitglied darfst du nicht entfernen.';
  end if;

  delete from public.group_members
  where group_id = managers_group_id and user_id = target_user_id;
end;
$$;

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.entries enable row level security;

drop policy if exists "group profiles are visible" on public.profiles;
create policy "group profiles are visible" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.shares_group_with(id));

drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists "members view their group" on public.groups;
create policy "members view their group" on public.groups
  for select to authenticated
  using (public.is_group_member(id));

drop policy if exists "members view memberships" on public.group_members;
create policy "members view memberships" on public.group_members
  for select to authenticated
  using (public.is_group_member(group_id));

drop policy if exists "visible entries for group" on public.entries;
create policy "visible entries for group" on public.entries
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (visibility = 'group' and public.shares_group_with(user_id))
    or public.is_group_admin_for_user(user_id)
  );

drop policy if exists "users create own entries" on public.entries;
create policy "users create own entries" on public.entries
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "users update own entries" on public.entries;
create policy "users update own entries" on public.entries
  for update to authenticated
  using (user_id = (select auth.uid()) or public.is_group_admin_for_user(user_id))
  with check (user_id = (select auth.uid()) or public.is_group_admin_for_user(user_id));

drop policy if exists "users delete own entries" on public.entries;
create policy "users delete own entries" on public.entries
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.is_group_admin_for_user(user_id));

revoke all on public.profiles, public.groups, public.group_members, public.entries from anon;
grant select, update on public.profiles to authenticated;
revoke select on public.groups from authenticated;
grant select (id, name, owner_id, max_members, created_at) on public.groups to authenticated;
grant select on public.group_members to authenticated;
grant select, insert, update, delete on public.entries to authenticated;

revoke all on function public.is_group_member(uuid) from public;
revoke all on function public.shares_group_with(uuid) from public;
revoke all on function public.is_group_admin_for_user(uuid) from public;
revoke all on function public.create_private_group(text) from public;
revoke all on function public.join_private_group(text) from public;
revoke all on function public.get_group_invite_code() from public;
revoke all on function public.set_group_member_role(uuid, text) from public;
revoke all on function public.remove_group_member(uuid) from public;
grant execute on function public.is_group_member(uuid) to authenticated;
grant execute on function public.shares_group_with(uuid) to authenticated;
grant execute on function public.is_group_admin_for_user(uuid) to authenticated;
grant execute on function public.create_private_group(text) to authenticated;
grant execute on function public.join_private_group(text) to authenticated;
grant execute on function public.get_group_invite_code() to authenticated;
grant execute on function public.set_group_member_role(uuid, text) to authenticated;
grant execute on function public.remove_group_member(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'entries'
  ) then
    alter publication supabase_realtime add table public.entries;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_members'
  ) then
    alter publication supabase_realtime add table public.group_members;
  end if;
end $$;
