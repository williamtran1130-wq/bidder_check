-- Name generation runs only at INSERT; later profile and workspace edits are independent.
begin;

create function private.workspace_default_name(p_owner uuid)
returns text language sql stable security definer set search_path='' as $$
  select 'Workspace - ' || left(coalesce(
    nullif(regexp_replace(p.display_name, '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''),
    nullif(regexp_replace(split_part(p.email, '@', 1), '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''),
    'Client'
  ), 88)
  from public.profiles p where p.id=p_owner
$$;
revoke all on function private.workspace_default_name(uuid) from public,anon,authenticated,service_role;

create function private.set_workspace_default_name()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.name is null or regexp_replace(new.name, '^[[:space:]]+|[[:space:]]+$', '', 'g') in ('', 'My workspace') then
    new.name := private.workspace_default_name(new.owner_id);
  end if;
  return new;
end
$$;
revoke all on function private.set_workspace_default_name() from public,anon,authenticated,service_role;

-- Block concurrent inserts and renames until capture and replacement commit together.
lock table public.workspaces in access exclusive mode;
alter table public.workspaces alter column name drop default;
create trigger set_workspace_default_name before insert on public.workspaces
for each row execute function private.set_workspace_default_name();

-- Retain old custom names as well as defaults. No FK: keep the backup if a row is deleted.
create table private.workspace_display_names_202610120007 (
  workspace_id uuid primary key,
  old_name text not null,
  new_name text not null
);
alter table private.workspace_display_names_202610120007 enable row level security;
revoke all on table private.workspace_display_names_202610120007 from public,anon,authenticated,service_role;

insert into private.workspace_display_names_202610120007(workspace_id,old_name,new_name)
select w.id,w.name,private.workspace_default_name(w.owner_id)
from public.workspaces w;

update public.workspaces w
set name=b.new_name
from private.workspace_display_names_202610120007 b
where w.id=b.workspace_id;

-- Manual data rollback as the database owner (not an application role):
-- select private.rollback_workspace_display_names_202610120007();
-- Returns the number restored. Only names still matching this migration are restored;
-- newer workspaces and later custom renames are untouched. INSERT naming remains enabled.
create function private.rollback_workspace_display_names_202610120007()
returns bigint language plpgsql security invoker set search_path='' as $$
declare restored bigint;
begin
  lock table public.workspaces in share row exclusive mode;
  update public.workspaces w
  set name=b.old_name
  from private.workspace_display_names_202610120007 b
  where w.id=b.workspace_id and w.name=b.new_name;
  get diagnostics restored = row_count;
  return restored;
end
$$;
revoke all on function private.rollback_workspace_display_names_202610120007() from public,anon,authenticated,service_role;

commit;
