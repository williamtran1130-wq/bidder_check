-- Preserve the current active-only validation and edit behavior while narrowing
-- creation conflicts to a typed, detail-free result.
do $migration$
declare source text; changed text; before_fragment text; after_fragment text;
begin
 source=pg_get_functiondef('public.save_bid(uuid,uuid,text,text,text,text,text,text)'::regprocedure);
 source=replace(source,E'\r\n',E'\n');
 before_fragment=$fragment$issues=public.candidate_bid_issues(r.profile_id,null,trim(p_company),trim(p_role),p_url);
  if jsonb_array_length(issues)>0 then raise exception '%',issues->0->>'message'; end if;$fragment$;
 after_fragment=$fragment$issues=public.candidate_bid_issues(r.profile_id,null,trim(p_company),trim(p_role),p_url);
  if exists(select 1 from jsonb_array_elements(issues) issue where issue->>'code' not in ('restricted_company','restricted_role','restricted_link','duplicate_url','duplicate_company_role','company_limit')) then
   raise exception '%',issues->0->>'message';
  end if;
  if jsonb_array_length(issues)>0 then raise exception using errcode='PBC01', message='Blocked'; end if;$fragment$;
 changed=replace(source,replace(before_fragment,E'\r\n',E'\n'),replace(after_fragment,E'\r\n',E'\n'));
 if changed=source then raise exception 'save_bid creation branch no longer matches'; end if;
 execute changed;
 source=pg_get_functiondef('public.validate_bid_import(uuid,date,jsonb)'::regprocedure);
 source=replace(source,E'\r\n',E'\n');
 before_fragment=$fragment$select * into p from public.candidate_profiles where id=r.profile_id;
 if r.archived or p.archived or exists(select 1 from public.bidders where user_id=r.bidder_id and archived) then raise exception 'Resume, profile or bidder archived'; end if;
 perform pg_advisory_xact_lock(hashtextextended(r.profile_id::text,0));$fragment$;
 after_fragment=$fragment$perform pg_advisory_xact_lock(hashtextextended(r.profile_id::text,0));
 select * into p from public.candidate_profiles where id=r.profile_id;
 if p.id is null then raise exception 'The shared candidate profile is unavailable'; end if;
 if r.archived or p.archived or exists(select 1 from public.bidders where user_id=r.bidder_id and archived) then raise exception 'Resume, profile or bidder archived'; end if;$fragment$;
 changed=replace(source,replace(before_fragment,E'\r\n',E'\n'),replace(after_fragment,E'\r\n',E'\n'));
 if changed=source then raise exception 'Import profile lock protocol no longer matches'; end if;
 execute changed;
 source=pg_get_functiondef('public.import_bids_reviewed(uuid,date,jsonb,integer[],uuid)'::regprocedure);
 source=replace(source,E'\r\n',E'\n');
 before_fragment=$fragment$if jsonb_array_length(valid_rows)=0 then return jsonb_build_object('ids','[]'::jsonb,'sourceRows','[]'::jsonb,'skipped',skipped,'date',p_date,'bidder',r.bidder_id,'resume',r.id); end if;$fragment$;
 after_fragment=$fragment$if jsonb_array_length(valid_rows)=0 then
  result=jsonb_build_object('ids','[]'::jsonb,'sourceRows','[]'::jsonb,'skipped',skipped,'date',p_date,'bidder',r.bidder_id,'resume',r.id);
  insert into public.bid_import_receipts(actor_id,request_id,payload_hash,result) values(auth.uid(),p_request,fingerprint,result);
  return result;
 end if;$fragment$;
 changed=replace(source,replace(before_fragment,E'\r\n',E'\n'),replace(after_fragment,E'\r\n',E'\n'));
 if changed=source then raise exception 'Zero-row import outcome no longer matches'; end if;
 execute changed;
end
$migration$;
