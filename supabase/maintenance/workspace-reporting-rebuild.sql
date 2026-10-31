-- Explicit repair only. This serializes writers while rebuilding live summaries;
-- it never changes bids, retained history, rates, or mail classifications.
begin;
select private.rebuild_bid_report_daily();
do $$ begin
 if private.reconcile_bid_report_daily()<>0 then raise exception 'Reporting reconciliation failed'; end if;
end $$;
commit;
