# Mail metrics and original theme — approved design

Approved in conversation on 2026-10-31. Use Bidder Check's original lavender light/dark theme across Mail Check and cloud email insights. Keep the existing mail report API, snapshot v1, permissions, CT dates, and 90-day email retention. No dependencies or database migration.

Confirmation metrics count application_ack messages; invitations count interview_invite. Use current authorized assignments, stable IDs, unique mailboxes globally and within each group. Shared groups may overlap. Report-linked counts exclude unassigned mailboxes, while existing manager email sections retain them. Show missing, outside-retention and partial coverage explicitly; only synced, covered empty data is a complete zero. Unknown/late coverage_start or missing snapshots makes coverage partial; suppress ratios.

Overview gains confirmation series and third bidder/profile metric with accessible values, including email-only groups. Move email section after comparisons, categories followed by activity. Only activity starts collapsed; remember account/workspace/browser state safely.

Earnings gains Applications received card and adjacent table column, grouped by bidder or resume assignment and unique total. Include embedded bidder earnings with pinned workspace. Preserve earnings math.

Interviews replaces all invitation values with mail counts. Preserve applied denominator restricted to effective mail report dates; label percentage Invitation emails / applications, allow >100%, suppress for denominator zero/incomplete mail. Never substitute manual flags on mail failure. Preserve Overview's separate existing interview conversion.

Admin must select workspace for email metrics on each report; selected workspace scopes bids too. Bid data remains available without mail. Main metrics ignore section-only mail filters. Use one snapshot query per page.

Approaches: user chose shared client loading/projection using existing API over extending SQL reports, avoiding migration/compatibility costs. User chose text palette specification, table-only collapse, Earnings card+column, invitations throughout Interviews, and applied-bid denominator.

Palette light/dark: interview #8576ed/#9c8fff; assessment #b59655/#d8be83; offer #34b991/#55cda8; info #4a9393/#7cbdbd; recruiter #9a86bc/#c0abd9; rejection #b57887/#d6a0ad; confirmation #6357df/#9c92ff; alert #8195b4/#a7b8d1; other #7d879b/#aab2c3; unknown #a29483/#c7b9a6. Subdued badges with readable foregrounds.

Include existing Windows credential chunking fix after review/validation in separate commit. Preserve scratch/audit docs outside release. Mail Check desktop 0.5.1 isolated build, draft installer/checksum/nupkg/RELEASES, packaged acceptance; deploy Bidder production, test synthetic cross-role/tenant metrics and cleanup, then publish stable desktop release. Record evidence and rollback refs. User authorized commits, pushes, deployment and publication; no repeated approval needed.
