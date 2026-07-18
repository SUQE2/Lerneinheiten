-- Ein Lernzeiteintrag kann mehreren Gruppen zugeordnet werden.

create table if not exists public.entry_groups (
  entry_id uuid not null references public.entries(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (entry_id, group_id)
);

create table if not exists public.group_weekly_goals (
  group_id uuid primary key references public.groups(id) on delete cascade,
  weekly_minutes integer not null check (weekly_minutes between 30 and 100800),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

alter table public.entries add column if not exists deleted_at timestamptz;

insert into public.entry_groups (entry_id, group_id)
select id, group_id from public.entries where group_id is not null
on conflict do nothing;

-- Zusammengehörige Datensätze der bisherigen Mehrfachauswahl werden zu einem
-- Eintrag vereinigt; alle Gruppenzuordnungen bleiben erhalten.
do $$
declare
  duplicate record;
begin
  for duplicate in
    select id, canonical_id
    from (
      select
        id,
        first_value(id) over (
          partition by user_id, created_at
          order by id
        ) as canonical_id
      from public.entries
    ) ranked
    where id <> canonical_id
  loop
    insert into public.entry_groups (entry_id, group_id)
    select duplicate.canonical_id, group_id
    from public.entry_groups
    where entry_id = duplicate.id
    on conflict do nothing;
    delete from public.entries where id = duplicate.id;
  end loop;
end $$;

create index if not exists entry_groups_group_idx on public.entry_groups(group_id, entry_id);
create index if not exists entries_deleted_idx on public.entries(deleted_at) where deleted_at is null;

create or replace function public.can_view_entry(target_entry_id uuid, entry_visibility text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.entry_groups association
    join public.group_members membership on membership.group_id = association.group_id
    where association.entry_id = target_entry_id
      and membership.user_id = (select auth.uid())
      and (
        entry_visibility = 'group'
        or (entry_visibility = 'admins' and membership.role in ('owner', 'admin'))
      )
  );
$$;

create or replace function public.can_manage_entry(target_entry_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.entry_groups association
    where association.entry_id = target_entry_id
      and public.is_group_admin(association.group_id)
  );
$$;

create or replace function public.save_learning_entry(
  target_entry_id uuid,
  target_entry_date date,
  target_category text,
  target_minutes integer,
  target_topic text,
  target_visibility text,
  target_group_ids uuid[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  cleaned_group_ids uuid[] := coalesce(target_group_ids, '{}');
  cleaned_visibility text := target_visibility;
begin
  if (select auth.uid()) is null then raise exception 'Du musst angemeldet sein.'; end if;
  if target_entry_id is null then raise exception 'Eintrag-ID fehlt.'; end if;
  if exists (
    select 1 from public.entries
    where id = target_entry_id and user_id <> (select auth.uid())
  ) then raise exception 'Du darfst diesen Eintrag nicht bearbeiten.'; end if;
  if exists (
    select 1 from unnest(cleaned_group_ids) selected_group_id
    where not public.is_group_member(selected_group_id)
  ) then raise exception 'Du bist nicht Mitglied jeder ausgewählten Gruppe.'; end if;
  if cardinality(cleaned_group_ids) = 0 then cleaned_visibility := 'private'; end if;

  insert into public.entries (
    id, user_id, group_id, entry_date, category, minutes, topic, visibility, deleted_at, updated_at
  ) values (
    target_entry_id,
    (select auth.uid()),
    cleaned_group_ids[1],
    target_entry_date,
    target_category,
    target_minutes,
    coalesce(trim(target_topic), ''),
    cleaned_visibility,
    null,
    now()
  )
  on conflict (id) do update set
    group_id = excluded.group_id,
    entry_date = excluded.entry_date,
    category = excluded.category,
    minutes = excluded.minutes,
    topic = excluded.topic,
    visibility = excluded.visibility,
    deleted_at = null,
    updated_at = now()
  where public.entries.user_id = (select auth.uid());

  delete from public.entry_groups where entry_id = target_entry_id;
  insert into public.entry_groups (entry_id, group_id)
  select target_entry_id, selected_group_id
  from (select distinct unnest(cleaned_group_ids) as selected_group_id) selected
  where selected_group_id is not null;
  return target_entry_id;
end;
$$;

create or replace function public.delete_entry(target_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_entry public.entries%rowtype;
begin
  select * into target_entry from public.entries where id = target_entry_id;
  if target_entry.id is null then raise exception 'Eintrag nicht gefunden.'; end if;
  if target_entry.user_id <> (select auth.uid()) and not (
    target_entry.visibility <> 'private'
    and exists (
      select 1 from public.entry_groups association
      where association.entry_id = target_entry.id
        and public.is_group_admin(association.group_id)
    )
  ) then raise exception 'Du darfst diesen Eintrag nicht löschen.'; end if;

  update public.entries set deleted_at = now(), updated_at = now() where id = target_entry_id;
  if target_entry.user_id <> (select auth.uid()) then
    perform public.write_group_audit(
      (select group_id from public.entry_groups where entry_id = target_entry.id and public.is_group_admin(group_id) limit 1),
      'entry_deleted_by_admin',
      target_entry.user_id,
      jsonb_build_object('entryId', target_entry.id, 'topic', target_entry.topic)
    );
  end if;
end;
$$;

create or replace function public.restore_own_entry(target_entry_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.entries
  set deleted_at = null, updated_at = now()
  where id = target_entry_id and user_id = (select auth.uid());
$$;

create or replace function public.remove_entry_from_group(target_entry_id uuid, target_group_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_entry public.entries%rowtype;
begin
  if not public.is_group_admin(target_group_id) then
    raise exception 'Du darfst diesen Gruppeneintrag nicht entfernen.';
  end if;
  select * into target_entry from public.entries where id = target_entry_id;
  if target_entry.id is null or target_entry.visibility = 'private' then
    raise exception 'Eintrag nicht gefunden.';
  end if;
  delete from public.entry_groups
  where entry_id = target_entry_id and group_id = target_group_id;
  if not found then raise exception 'Dieser Eintrag gehört nicht zu deiner Gruppe.'; end if;
  update public.entries
  set group_id = (select group_id from public.entry_groups where entry_id = target_entry_id limit 1),
      updated_at = now()
  where id = target_entry_id;
  perform public.write_group_audit(
    target_group_id,
    'entry_deleted_by_admin',
    target_entry.user_id,
    jsonb_build_object('entryId', target_entry.id, 'topic', target_entry.topic)
  );
end;
$$;

create or replace function public.set_group_weekly_goal(target_group_id uuid, target_minutes integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_group_admin(target_group_id) then
    raise exception 'Nur Admins dürfen das Gruppenziel ändern.';
  end if;
  if target_minutes is null or target_minutes < 30 or target_minutes > 100800 then
    raise exception 'Das Gruppenziel muss zwischen 30 Minuten und 1.680 Stunden liegen.';
  end if;
  insert into public.group_weekly_goals (group_id, weekly_minutes, updated_at, updated_by)
  values (target_group_id, target_minutes, now(), (select auth.uid()))
  on conflict (group_id) do update set
    weekly_minutes = excluded.weekly_minutes,
    updated_at = now(),
    updated_by = (select auth.uid());
  perform public.write_group_audit(
    target_group_id,
    'group_goal_changed',
    null,
    jsonb_build_object('weeklyMinutes', target_minutes)
  );
end;
$$;

create or replace function public.remove_departed_member_entry_groups()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.entry_groups association
  using public.entries entry
  where association.entry_id = entry.id
    and association.group_id = old.group_id
    and entry.user_id = old.user_id;
  update public.entries
  set group_id = null
  where group_id = old.group_id and user_id = old.user_id;
  return old;
end;
$$;

drop trigger if exists remove_departed_member_entry_groups on public.group_members;
create trigger remove_departed_member_entry_groups
  after delete on public.group_members
  for each row execute procedure public.remove_departed_member_entry_groups();

alter table public.entry_groups enable row level security;
alter table public.group_weekly_goals enable row level security;

drop policy if exists "visible entries for group" on public.entries;
create policy "visible entries for group" on public.entries
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (deleted_at is null and public.can_view_entry(id, visibility))
  );

drop policy if exists "users update own entries" on public.entries;
create policy "users update own entries" on public.entries
  for update to authenticated
  using (
    user_id = (select auth.uid())
    or (visibility <> 'private' and public.can_manage_entry(id))
  )
  with check (
    user_id = (select auth.uid())
    or (visibility <> 'private' and public.can_manage_entry(id))
  );

drop policy if exists "entry associations are visible" on public.entry_groups;
create policy "entry associations are visible" on public.entry_groups
  for select to authenticated
  using (
    public.is_group_member(group_id)
    or exists (
      select 1 from public.entries entry
      where entry.id = entry_id and entry.user_id = (select auth.uid())
    )
  );

drop policy if exists "members view group goals" on public.group_weekly_goals;
create policy "members view group goals" on public.group_weekly_goals
  for select to authenticated
  using (public.is_group_member(group_id));

revoke all on public.entry_groups, public.group_weekly_goals from anon;
revoke all on public.entry_groups, public.group_weekly_goals from authenticated;
grant select on public.entry_groups, public.group_weekly_goals to authenticated;

revoke all on function public.can_view_entry(uuid, text) from public;
revoke all on function public.can_manage_entry(uuid) from public;
revoke all on function public.save_learning_entry(uuid, date, text, integer, text, text, uuid[]) from public;
revoke all on function public.restore_own_entry(uuid) from public;
revoke all on function public.remove_entry_from_group(uuid, uuid) from public;
revoke all on function public.set_group_weekly_goal(uuid, integer) from public;
revoke all on function public.remove_departed_member_entry_groups() from public;
grant execute on function public.can_view_entry(uuid, text) to authenticated;
grant execute on function public.can_manage_entry(uuid) to authenticated;
grant execute on function public.save_learning_entry(uuid, date, text, integer, text, text, uuid[]) to authenticated;
grant execute on function public.restore_own_entry(uuid) to authenticated;
grant execute on function public.remove_entry_from_group(uuid, uuid) to authenticated;
grant execute on function public.set_group_weekly_goal(uuid, integer) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_weekly_goals'
  ) then
    alter publication supabase_realtime add table public.group_weekly_goals;
  end if;
end $$;
