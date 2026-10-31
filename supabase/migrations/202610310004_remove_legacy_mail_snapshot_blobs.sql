-- Run after the compatible normalized readers are deployed. Receipts and
-- normalized mailbox/category counts remain intact for both v1 and v2 publishers.
update public.mail_insights_state
set mailboxes = '[]'::jsonb
where mailboxes <> '[]'::jsonb;
