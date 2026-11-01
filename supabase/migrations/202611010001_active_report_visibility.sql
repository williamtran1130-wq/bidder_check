-- Presentation visibility is independent of historical accounting. Never filter
-- source counters or financial totals when an identity becomes inactive.
create or replace function private.visible_report_groups(p_groups jsonb,p_group text) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(g.value order by g.ordinality),'[]'::jsonb)
 from jsonb_array_elements(coalesce(p_groups,'[]'::jsonb)) with ordinality g(value,ordinality)
 where exists (
  select 1 from public.resumes r
  join public.candidate_profiles cp on cp.id=r.profile_id and cp.workspace_id=r.workspace_id
  join public.bidders b on b.user_id=r.bidder_id and b.workspace_id=r.workspace_id
  join public.profiles bp on bp.id=b.user_id
  join public.workspaces w on w.id=r.workspace_id
  join public.profiles owner on owner.id=w.owner_id
  where ((p_group='bidder' and r.bidder_id=(g.value->>'id')::uuid)
   or (p_group='profile' and r.profile_id=(g.value->>'id')::uuid)
   or (p_group not in ('bidder','profile') and r.id=(g.value->>'id')::uuid))
   and not r.archived and not cp.archived and not b.archived and not bp.archived
   and bp.role='bidder' and not owner.archived
 )
$$;

create or replace function private.visible_application_report(p_report jsonb,p_kind text,p_group text) returns jsonb
language sql stable security definer set search_path='' as $$
 select case when p_kind='overview' then
  jsonb_set(jsonb_set(p_report,'{comparisons,bidders}',private.visible_report_groups(p_report#>'{comparisons,bidders}','bidder')),
   '{comparisons,profiles}',private.visible_report_groups(p_report#>'{comparisons,profiles}','profile'))
 else jsonb_set(p_report,'{groups}',private.visible_report_groups(p_report->'groups',p_group)) end
$$;

create or replace function private.visible_mail_assignments(p_mail jsonb) returns jsonb
language sql stable security definer set search_path='' as $$
 select case when p_mail is null then null else jsonb_set(p_mail,'{assignments}',coalesce((
  select jsonb_agg(a.value||jsonb_build_object('archived',coalesce((a.value->>'archived')::boolean,false) or
   r.id is null or cp.id is null or b.user_id is null or bp.id is null or owner.id is null or
   r.archived or cp.archived or b.archived or bp.archived or bp.role<>'bidder' or owner.archived) order by a.ordinality)
  from jsonb_array_elements(p_mail->'assignments') with ordinality a(value,ordinality)
  left join public.resumes r on r.id=(a.value->>'id')::uuid
  left join public.candidate_profiles cp on cp.id=r.profile_id and cp.workspace_id=r.workspace_id
  left join public.bidders b on b.user_id=r.bidder_id and b.workspace_id=r.workspace_id
  left join public.profiles bp on bp.id=b.user_id
  left join public.workspaces w on w.id=r.workspace_id
  left join public.profiles owner on owner.id=w.owner_id
 ),'[]'::jsonb)) end
$$;

revoke all on function private.visible_report_groups(jsonb,text),private.visible_application_report(jsonb,text,text),private.visible_mail_assignments(jsonb) from public,anon,authenticated;

-- Preserve the established bundle's authorization, totals, date/rate calculations
-- and grants. Apply display visibility only after those calculations complete.
do $$
declare definition text; original text:=$old$'report',application_report,'mail',mail,'collection',collection$old$;
 replacement text:=$new$'report',private.visible_application_report(application_report,p_kind,p_group),'mail',private.visible_mail_assignments(mail),'collection',collection$new$;
begin
 definition:=pg_get_functiondef('public.workspace_report_bundle(text,date,date,uuid,uuid,uuid,text,text)'::regprocedure);
 if strpos(definition,original)>0 then execute replace(definition,original,replacement);
 elsif strpos(definition,replacement)=0 then raise exception 'Unexpected workspace report definition; refusing visibility cutover';
 end if;
end $$;
