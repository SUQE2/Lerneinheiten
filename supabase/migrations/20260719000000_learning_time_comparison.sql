-- Unterscheidet die gesamte Sitzzeit von der tatsächlich gelernten Zeit.

alter table public.entries add column if not exists elapsed_minutes integer;
update public.entries set elapsed_minutes = minutes where elapsed_minutes is null;
alter table public.entries alter column elapsed_minutes set not null;
alter table public.entries drop constraint if exists entries_elapsed_minutes_check;
alter table public.entries
  add constraint entries_elapsed_minutes_check check (elapsed_minutes between minutes and 1439);

drop function if exists public.save_learning_entry(uuid, date, text, integer, text, text, uuid[]);

create or replace function public.save_learning_entry(
  target_entry_id uuid,
  target_entry_date date,
  target_category text,
  target_minutes integer,
  target_elapsed_minutes integer,
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
  if target_elapsed_minutes is null or target_elapsed_minutes < target_minutes or target_elapsed_minutes > 1439 then
    raise exception 'Die gesamte Sitzzeit muss mindestens der tatsächlichen Lernzeit entsprechen.';
  end if;
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
    id, user_id, group_id, entry_date, category, minutes, elapsed_minutes, topic, visibility, deleted_at, updated_at
  ) values (
    target_entry_id,
    (select auth.uid()),
    cleaned_group_ids[1],
    target_entry_date,
    target_category,
    target_minutes,
    target_elapsed_minutes,
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
    elapsed_minutes = excluded.elapsed_minutes,
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

revoke all on function public.save_learning_entry(uuid, date, text, integer, integer, text, text, uuid[]) from public;
grant execute on function public.save_learning_entry(uuid, date, text, integer, integer, text, text, uuid[]) to authenticated;
