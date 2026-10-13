# Reliable notifications, private screenshot review, and clear resume filters

Approved implementation plan. Use Superpowers subagent-driven development, test-first regression coverage, focused reviews, then whole-branch verification.

## Global requirements

- Preserve Next.js/Supabase/Recharts stack, design system, period defaults and Pending review's existing All time transition.
- Size badges/sorts/repeated filters and upload IP/location details are restricted to active, approved clients/admins in authorized workspaces. Bidder responses omit size and location review metadata.
- Repeated sizes means exact file bytes appearing on at least two applications within all current filters across all pages; it does not identify identical image contents.
- Daily notifications repeat authored messages in America/Chicago. Resume at the next future scheduled slot; no paused-period replay. Retain in-app plus optional browser push.
- Upload history follows bid lifetime; replacement, trash and physical/file-metadata cleanup do not remove context. Permanent bid deletion does.
- Preserve records and historical migrations. Add migrations before app rollout. Server read release ceiling remains raw p95 <10000ms with five concurrent authenticated readers at twice representative production volume.
- Do not expose credentials, raw IP data, push endpoints, customer records or Vault values in logs/artifacts. No notification sends or hosted mutations during ordinary inspection.
- Read installed Next.js documentation before relevant changes. Node 22.23.3, lockfile unchanged unless required by demonstrated need.

### Task 1: Reliable notification scheduling and delivery

Own notification-specific modules, component/page, shell notification polling integration, notification worker and migration 202610120013_notification_reliability.sql. Keep implementation in dedicated notification actions/types/store modules rather than expanding central actions. Do not edit central actions.ts, database.types.ts, tests/preview/actions.ts, tests/preview/vite.config.ts or tests/preview/main.tsx; publish integration requirements for controller.

Requirements:
- Composer sections Recipients / Message / Delivery. Now, Once later, Daily, Selected weekdays; explicit Send now / Schedule / Save changes, secondary Save draft for new/draft messages.
- New repeating time 09:00 CT; preserve edits. Workspace-scoped eligible bidders, remove incompatible recipients, show count. Readable next delivery preview.
- Typed schedule contract and shared SQL resolver for preview/save/publish/resume. Persist send_on_publish for immediate drafts. Send now needs no date; scheduled once must be future. Reject nonexistent once times, recurring spring gap shifts forward; first fall-back occurrence only. Use same resolver everywhere and show actual resolved time.
- Editing paused messages stays paused. Resume recurring at next future slot; expired one-off requires edited time or explicit Send now. Repair active recurring next_at null in forward migration. Keep latest-due-only outage catch-up and occurrence/inbox uniqueness.
- Accurate Queued / Scheduled / Paused / Published to N inboxes labels; do not conflate push-provider acceptance with actual delivery. Show current per-device enable/disable state and permission errors.
- Cursor list APIs 50/page with exact unread counts, next/latest publication summaries, authorized by-ID deep-link access even beyond first page. Honest unavailable/retry states. Deduplicated 30s foreground polling shared between shell and inbox/schedules, preserving composer and matching-scope prior results.
- Index due messages, unfinished push attempts and cursors. Bound enqueue to 500 missing notification/subscription pairs ordered oldest first AFTER excluding existing attempts. Preserve notification.created_at >= subscription.created_at and current eligibility/device ownership rules; no one-shot cursor that loses late commits.
- Claim just-in-time batches of 5; concurrency 5, provider timeout 5s, work budget 40s, max100 attempts/run; leave remaining durable work. Require nonnull equal lease on completion so stale success/error/410 cannot mutate completed work/current subscription. Preserve at-least-once push semantics.
- Add real SQL/worker/unit/browser regressions for scheduling, paused edit+resume, now drafts, DST, null repair, missed runs, simultaneous workers, stale completion, future device timestamps/rotation, unavailable VAPID, provider timeout, recipient authorization, pagination and errors.

Interfaces: create src/lib/notification-types.ts and src/app/(workspace)/notification-actions.ts, exposing typed preview/save/status/paged-list/by-ID/unread/push APIs. Publish exact exported signatures and SQL type additions to controller. New preview alias module can be owned here; controller integrates shared Vite/main/actions fixture files.

### Task 2: Repeated screenshot sizes query

Own migration 202610120014_repeated_screenshot_sizes.sql and focused new tests/tests helpers. Controller owns Bids UI, query adapter and shared fixtures. Keep list_bids_v2(p_query jsonb) signature and existing fields.

Requirements:
- Screenshot dropdown values All (empty), Has screenshot, No screenshot, Repeated sizes only. Existing columnFilters.screenshot accepts new value. Normalize before old boolean presence predicate. For unapproved/nonmanager roles, new mode becomes All, size sort unsupported fallback, no size metadata returned.
- Common authorized base applies every filter except status and repeated eligibility. Current valid evidence joins exact attached ID, bid, workspace, bidder, screenshot kind and finalized state. Materialize once: all base when repeated mode; selected status in ordinary mode to preserve narrow fast path.
- Group exact size bytes and independently count all/applied/unapplied/pending rows. Selected status rows qualify when corresponding count >=2. Badge count equals count within selected status and all other current filters. Exclude unavailable, historical/replaced, unfinalized and mismatched evidence.
- Filtering before sorting/pagination; stable sort ties unchanged. Each status count uses its own repeated eligibility under current nonstatus filters; selected total=statusCounts[selected]. All counts may be nonadditive: one applied+one unapplied at same size -> All2/Applied0/Unapplied0. Existing period changes recalculate whole snapshot.
- Tests cross-page matches, statuses, byte values with same rounded label, filters, trash, tenant isolation, missing evidence, replacements, bidder direct requests. No new per-row permission queries or client-page counting.

### Task 3: Private upload location history

Own migration 202610120015_screenshot_upload_context.sql, upload-context helper/actions/types/component, screenshot-cell.tsx, file-upload.tsx, and ONLY finalizeUpload function/import additions in central actions.ts. Controller owns Bids history integration and database.types.ts. Avoid editing central actions elsewhere.

Requirements:
- At authenticated finalizeUpload capture await headers() trusted Vercel request IP/city/region/country. Use platform-specific IP header, validate IPv4/IPv6 and bounded decoded geographic strings; no external geo requests, device GPS or client-submitted network fields. Non-Vercel/missing/invalid metadata becomes Unavailable.
- Service-only versioned verified finalizer preserves ownership, JWT/RLS, approval revision, image validation, hash, locking and financial calculations. Atomically attach screenshot and insert immutable context on first success only. Existing finalized retries must not add/backfill or overwrite context. Replacement gets new record. Rejected/unfinished uploads create none.
- Private table owned by bid FK ON DELETE CASCADE; original_file_id immutable unique snapshot with no file FK cascade. Derive bid/workspace/bidder/actual uploader+role from locked authoritative rows. Store successful time, inet IP, city/region/country, source/status. Never attribute manager network location to bidder.
- Preserve through trash/replacement/file metadata deletion; disappear on bid purge/retention/reset. No raw location in retained aggregates, broad files/bid_events projections or bidder payloads.
- Manager-authorized current-file lookup and cursor history50 per bid. Lazy on opening preview/details only; no list/thumbnail/size-count additions. History left joins optional file metadata; display Screenshot unavailable while retaining context.
- Render Upload details, actor/time/copyable IP/Approximate IP location; historical Not recorded vs new Unavailable vs load failure. Concise visible upload/paste notice including VPN/proxy limitation. Bidders see collection notice but no manager review data.
- Real regression tests trusted/malformed/missing/encoded metadata, current actor, concurrent/lost-response retry with different IP, old files, atomicity, direct SQL/API role and cross-workspace denial, file deletion and all bid cleanup paths. Browser component tests including keyboard/mobile.

Interfaces: new dedicated src/app/(workspace)/upload-context-actions.ts and src/lib/upload-context.ts plus reusable upload details/history component. Publish signatures needed by Bids details/controller, exact types for database.types.ts, and fixture adapters.

### Task 4: Resume assignment selectors and shared integration

Controller owns src/components/bids.tsx, bid-grid.tsx, sheets-import.tsx, shared assignment label/search components, src/lib/bid-list.ts, shared preview fixtures/actions/config, database.types.ts, integration/browser tests, and documentation.

Requirements:
- Assignment UUID option values. Canonical profile ID+name primary; bidder name+assignment email secondary. Add workspace for admin collisions and short unique assignment ID only if still ambiguous. Shared formatter throughout filter/add/edit/import, profile column label clarified.
- Searchable profile-grouped filter using already-loaded authorized data/maps, no per-option reads. Search full collection, initially50 matches with Show50more outside listbox, stable keyboard focus, matched count announced, selected value always available. Scope to selected/fixed bidder; changing bidder resets incompatible resume atomically. Archived historical filters available/labeled; existing creation eligibility preserved.
- Integrate Repeated sizes only menu, existing size sorts only explicit roles client/admin; preserve sorting, reset pagination+selection, clear ->All. Specific empty text No applications with matching screenshot sizes. Role/user changes clear sensitive previous response and size filter/sort. Existing mutation refresh/edit deferral preserved.
- Integrate upload history in History & details and add shared type/fixture bridges. Keep bidder contexts omitted and financial restrictions intact.
- Fixtures must include shared profiles/multiple assignments/duplicate labels and full-filter repeated-size results with independent status counts. No incorrect page-local matches.

### Task 5: Verification, review and rollout

- Focused red/green tests and independent task reviews; whole branch review. All required issues fixed before release.
- Run lint, typecheck, complete unit/database suite, production build and relevant desktop/mobile/light-dark/keyboard browser suites. Preserve baseline period defaults and financial/privacy boundaries.
- Benchmark ordinary/repeated query with asc/desc size sorts, other filters and forbidden bidder requests against representative staging volume>=2x current and five concurrent authenticated readers; raw p95<10000ms, no timeouts. Record native exits, immutable artifact identities and fixture cleanup separately.
- Inspect scheduler deployed config, cron active/minute schedule, safe target hostname match and recent HTTP JSON outcomes without exposing secrets. Staging must publish scheduled messages within two cron cycles without open browser/direct processing, idempotently. Real-device push verification distinct from provider acceptance.
- Add forward migrations before compatible app, staging first then production. Preserve all existing records, prior migrations, independent worktrees/artifacts and financial-safe rollback compatibility. Production smoke read-only except isolated temporary auth sessions when existing authorized workflow requires; do not send customer messages to manufacture acceptance.
- Browser access was unavailable during planning. Try available browser again; run project-authorized browser suites. Report actual real-device/manual verification limits honestly.
