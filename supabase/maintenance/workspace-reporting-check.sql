-- Read-only reconciliation, run as the database owner after migration 001.
-- Zero means every stored live counter agrees with the source bids.
begin read only;
select private.reconcile_bid_report_daily() as differing_summary_rows;
rollback;
