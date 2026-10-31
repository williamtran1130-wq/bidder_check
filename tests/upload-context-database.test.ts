import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const migration =
  "supabase/migrations/202610310002_latest_application_location.sql";
const owner = "30000000-0000-4000-8000-000000000001",
  bidder = "30000000-0000-4000-8000-000000000002",
  other = "30000000-0000-4000-8000-000000000003",
  admin = "30000000-0000-4000-8000-000000000004";
let db: PGlite,
  workspace: string,
  resume: string,
  profile: string,
  bid: string,
  legacyBid: string;
const context = {
  ip: "203.0.113.10",
  city: "Chicago",
  region: "IL",
  country: "US",
  source: "vercel",
  status: "available",
};
async function asUser(actor = owner) {
  await db.exec("reset role; set role authenticated");
  await db.query(
    "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",
    [actor],
  );
}
async function service() {
  await db.exec(
    "reset role; set role service_role; select set_config('request.jwt.claim.role','service_role',false)",
  );
}
async function prepare(actor = bidder, target = bid) {
  await asUser(actor);
  return (
    await db.query<{ id: string }>(
      "select public.prepare_file('screenshot',$1,'proof.png','image/png',100) id",
      [target],
    )
  ).rows[0].id;
}
async function finalize(
  file: string,
  actor = bidder,
  metadata: unknown = context,
  hash = "a".repeat(64),
) {
  await service();
  await db.query(
    "select public.finalize_verified_file_v2($1,$2,$3,$4::jsonb)",
    [file, hash, actor, JSON.stringify(metadata)],
  );
}
async function current(target = bid) {
  return (
    (
      await db.query<{ location: Record<string, unknown> }>(
        "select location from private.application_locations() where bid_id=$1",
        [target],
      )
    ).rows[0]?.location ?? null
  );
}
async function list(query: Record<string, unknown> = {}) {
  return (
    await db.query<{
      value: {
        rows: {
          id: string;
          screenshot_uploaded_at: string | null;
          applicationLocation: Record<string, unknown> | null;
        }[];
        total: number;
        statusCounts: Record<string, number>;
        countryOptions: string[];
      };
    }>("select public.list_bids_v2($1::jsonb) value", [
      JSON.stringify({ pageSize: 100, ...query }),
    ])
  ).rows[0].value;
}
// Expected PostgreSQL errors abort a transaction: recover the statement's
// savepoint before inspecting the atomic rollback or testing another caller.
async function statement<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("savepoint expected_statement");
  try {
    const value = await fn();
    await db.exec("release savepoint expected_statement");
    return value;
  } catch (error) {
    await db.exec(
      "rollback to savepoint expected_statement; release savepoint expected_statement",
    );
    throw error;
  }
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb); alter table storage.objects enable row level security;
    grant usage on schema auth,storage to authenticated,service_role; grant all on storage.objects to authenticated,service_role;`);
  for (const file of readdirSync("supabase/migrations")
    .filter(
      (f) =>
        f.endsWith(".sql") &&
        f !== "202610310002_latest_application_location.sql",
    )
    .sort())
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  await db.query(
    "insert into auth.users(id,email) values($1,'owner@context.test'),($2,'bidder@context.test'),($3,'other@context.test'),($4,'admin@context.test')",
    [owner, bidder, other, admin],
  );
  await db.exec("update public.profiles set approval_status='approved'");
  await db.query(
    "update public.profiles set role='bidder',display_name='Uploader' where id=$1",
    [bidder],
  );
  await db.query("update public.profiles set role='admin' where id=$1", [
    admin,
  ]);
  workspace = (
    await db.query<{ id: string }>(
      "select id from public.workspaces where owner_id=$1",
      [owner],
    )
  ).rows[0].id;
  await db.query(
    "insert into public.bidders(user_id,workspace_id,default_rate_cents) values($1,$2,125)",
    [bidder, workspace],
  );
  await asUser();
  profile = (
    await db.query<{ id: string }>(
      "select public.save_candidate_profile(null,$1,'CTX','Candidate','','','') id",
      [workspace],
    )
  ).rows[0].id;
  resume = (
    await db.query<{ id: string }>(
      "select public.save_resume_assignment(null,$1,$2,'candidate@context.test','555-1000',null,null) id",
      [profile, bidder],
    )
  ).rows[0].id;
  const resumeFile = (
    await db.query<{ id: string }>(
      "select public.prepare_file('resume',$1,'resume.pdf','application/pdf',100) id",
      [resume],
    )
  ).rows[0].id;
  await service();
  await db.query("select public.finalize_verified_file($1,$2,$3)", [
    resumeFile,
    "c".repeat(64),
    owner,
  ]);
  await asUser();
  legacyBid = (
    await db.query<{ id: string }>(
      "select public.save_bid(null,$1,'Legacy Context','Engineer','https://context.test/legacy','Legacy','remote','open') id",
      [resume],
    )
  ).rows[0].id;
  await db.exec("reset role");
  await db.query(
    `insert into public.screenshot_upload_contexts(id,bid_id,workspace_id,bidder_id,original_file_id,uploader_id,uploader_role,uploaded_at,ip,country,source,status)
    values('10000000-0000-4000-8000-000000000001',$1,$2,$3,gen_random_uuid(),$3,'bidder','2026-10-12 12:00+00','203.0.113.1','US','vercel','available'),
    ('10000000-0000-4000-8000-000000000002',$1,$2,$3,gen_random_uuid(),$3,'bidder','2026-10-12 12:00+00','203.0.113.2','BR','vercel','available'),
    ('10000000-0000-4000-8000-000000000003',$1,$2,$3,gen_random_uuid(),$3,'bidder','2026-10-11 12:00+00','203.0.113.3','CA','vercel','available')`,
    [legacyBid, workspace, bidder],
  );
  await db.exec(readFileSync(migration, "utf8"));
}, 60000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("reset role; begin");
  await asUser();
  bid = (
    await db.query<{ id: string }>(
      "select public.save_bid(null,$1,'Context Company','Engineer','https://context.test/job','Board','remote','open') id",
      [resume],
    )
  ).rows[0].id;
});
afterEach(async () => {
  await db.exec("rollback; reset role");
});

it("backfills the last timestamp/id available and removes history schema and dependencies", async () => {
  await asUser();
  expect(await current(legacyBid)).toMatchObject({
    country: "BR",
    ip: "203.0.113.2",
  });
  await db.exec("reset role");
  expect(
    (
      await db.query(
        "select to_regclass('public.screenshot_upload_contexts') value",
      )
    ).rows[0],
  ).toEqual({ value: null });
  expect(
    (
      await db.query(
        "select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prosrc like '%screenshot_upload_contexts%'",
      )
    ).rows,
  ).toEqual([]);
});
it("atomically saves authoritative identity and keeps the first successful context on retry", async () => {
  const file = await prepare();
  await finalize(file);
  await asUser();
  const first = await current();
  expect(first).toMatchObject({
    ip: "203.0.113.10",
    city: "Chicago",
    country: "US",
  });
  await finalize(file, bidder, { ...context, ip: "198.51.100.2" });
  await asUser();
  expect(await current()).toEqual(first);
  expect(
    (await list()).rows.find((row) => row.id === bid)?.applicationLocation,
  ).toEqual(first);
  expect(
    (await list()).rows.find((row) => row.id === bid)?.screenshot_uploaded_at,
  ).toBe(first?.uploadedAt);
  await db.exec("reset role");
  expect(
    (
      await db.query(
        "select original_file_id,uploader_id,uploader_role,bidder_id from public.bid_application_locations where bid_id=$1",
        [bid],
      )
    ).rows[0],
  ).toMatchObject({
    original_file_id: file,
    uploader_id: bidder,
    uploader_role: "bidder",
    bidder_id: bidder,
  });
});
it("serializes simultaneous retries and keeps one row", async () => {
  const file = await prepare();
  await service();
  await Promise.all([
    db.query("select public.finalize_verified_file_v2($1,$2,$3,$4::jsonb)", [
      file,
      "a".repeat(64),
      bidder,
      JSON.stringify(context),
    ]),
    db.query("select public.finalize_verified_file_v2($1,$2,$3,$4::jsonb)", [
      file,
      "a".repeat(64),
      bidder,
      JSON.stringify({ ...context, ip: "198.51.100.2" }),
    ]),
  ]);
  await asUser();
  expect(await current()).toMatchObject({ ip: "203.0.113.10" });
  await db.exec("reset role");
  expect(
    (
      await db.query(
        "select bid_id from public.bid_application_locations where bid_id=$1",
        [bid],
      )
    ).rows,
  ).toHaveLength(1);
});
it("replaces location on successful manager upload and an old retry cannot overwrite it", async () => {
  const first = await prepare();
  await finalize(first);
  const replacement = await prepare(owner);
  await finalize(
    replacement,
    owner,
    { ...context, ip: "198.51.100.2", country: "CA" },
    "b".repeat(64),
  );
  await asUser();
  const latest = await current();
  expect(latest).toMatchObject({ ip: "198.51.100.2", country: "CA" });
  await statement(() => finalize(first)).catch(() => undefined);
  await asUser();
  expect(await current()).toEqual(latest);
  await db.exec("reset role");
  expect(
    (
      await db.query(
        "select uploader_id,uploader_role from public.bid_application_locations where bid_id=$1",
        [bid],
      )
    ).rows[0],
  ).toEqual({ uploader_id: owner, uploader_role: "client" });
});
it("a retained old finalized file retry cannot replace a newer location", async () => {
  const file = await prepare();
  await finalize(file);
  await asUser();
  const latest = await current();
  const old = await prepare();
  await db.exec("reset role");
  await db.query(
    "update public.files set finalized=true,sha256=$2 where id=$1",
    [old, "b".repeat(64)],
  );
  await finalize(
    old,
    bidder,
    { ...context, ip: "198.51.100.2", country: "CA" },
    "b".repeat(64),
  );
  await asUser();
  expect(await current()).toEqual(latest);
});
it("failed replacement leaves the previous successful location unchanged", async () => {
  const first = await prepare();
  await finalize(first);
  await asUser();
  const saved = await current();
  const next = await prepare();
  await expect(
    statement(() => finalize(next, bidder, context, "invalid")),
  ).rejects.toThrow(/Invalid verified upload/);
  await asUser();
  expect(await current()).toEqual(saved);
});
it("does not backfill finalized retries and records unavailable metadata explicitly", async () => {
  const old = await prepare();
  await service();
  await db.query("select public.finalize_verified_file($1,$2,$3)", [
    old,
    "a".repeat(64),
    bidder,
  ]);
  await finalize(old);
  await asUser();
  expect(await current()).toBeNull();
  const next = await prepare();
  await finalize(next, bidder, { ...context, ip: "bad" }, "b".repeat(64));
  await asUser();
  expect(await current()).toMatchObject({
    ip: null,
    city: null,
    country: null,
    source: "unavailable",
    status: "unavailable",
  });
});
it("keeps location through correction and expiry, and cascades only with bid deletion", async () => {
  const file = await prepare();
  await finalize(file);
  await asUser();
  const saved = await current();
  await db.exec("reset role");
  await db.query(
    "update public.bids set applied=false,evidence_file_id=null where id=$1",
    [bid],
  );
  await db.query("select private.detach_files(array[$1::uuid])", [file]);
  await db.query("select private.prune_file_cleanup_history(100)");
  await asUser();
  expect(await current()).toEqual(saved);
  expect((await list({ ipCountry: "US" })).rows.map((row) => row.id)).toContain(
    bid,
  );
  await db.exec("reset role");
  await db.query("delete from public.bid_events where bid_id=$1", [bid]);
  await db.query("delete from public.bids where id=$1", [bid]);
  expect(
    (
      await db.query(
        "select bid_id from public.bid_application_locations where bid_id=$1",
        [bid],
      )
    ).rows,
  ).toEqual([]);
});
it("authorizes own bidder, client and admin reads, denies foreign and inactive actors and direct table APIs", async () => {
  const file = await prepare();
  await finalize(file);
  for (const actor of [owner, bidder, admin]) {
    await asUser(actor);
    expect(await current()).toMatchObject({ country: "US" });
  }
  await asUser(other);
  expect(await current()).toBeNull();
  expect((await list()).rows).toEqual([]);
  for (const actor of [owner, bidder, other]) {
    await asUser(actor);
    await expect(
      statement(() =>
        db.query("select * from public.bid_application_locations"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  }
  for (const assignment of ["approval_status='pending'", "archived=true"]) {
    await db.exec("reset role");
    await db.query(`update public.profiles set ${assignment} where id=$1`, [
      owner,
    ]);
    await asUser();
    expect(await current()).toBeNull();
    await db.exec("reset role");
    await db.query(
      "update public.profiles set archived=false,approval_status='approved' where id=$1",
      [owner],
    );
  }
});
it("rolls application attachment back if location persistence fails", async () => {
  const file = await prepare();
  await db.exec("reset role");
  await db.exec(`create function public.test_context_reject() returns trigger language plpgsql as $$begin raise exception 'context failure'; end$$;
    create trigger test_context_reject before insert on public.bid_application_locations for each row execute function public.test_context_reject();`);
  await expect(statement(() => finalize(file))).rejects.toThrow(
    /context failure/,
  );
  await db.exec("reset role");
  expect(
    (await db.query("select finalized from public.files where id=$1", [file]))
      .rows[0],
  ).toEqual({ finalized: false });
  expect(
    (await db.query("select applied from public.bids where id=$1", [bid]))
      .rows[0],
  ).toEqual({ applied: false });
});
it("records nothing for unfinished, invalid, rejected or approval-changed uploads", async () => {
  const file = await prepare();
  await asUser();
  expect(await current()).toBeNull();
  await expect(
    statement(() => finalize(file, bidder, context, "invalid")),
  ).rejects.toThrow(/Invalid verified upload/);
  await db.exec("reset role");
  await db.query(
    "update public.bids set rejected_hashes=array[$2] where id=$1",
    [bid, "a".repeat(64)],
  );
  await expect(statement(() => finalize(file))).rejects.toThrow(
    /previously rejected/,
  );
  await db.exec("reset role");
  await db.query(
    "update public.bids set review_revision=review_revision+1,rejected_hashes='{}' where id=$1",
    [bid],
  );
  await expect(statement(() => finalize(file))).rejects.toThrow(
    /approval changed/i,
  );
  await asUser();
  expect(await current()).toBeNull();
});
it("denies anonymous reads and unauthenticated service-role claims", async () => {
  const file = await prepare();
  await finalize(file);
  await db.exec("reset role; set role anon");
  await expect(
    statement(() => db.query("select * from private.application_locations()")),
  ).rejects.toMatchObject({ code: "42501" });
  await db.exec(
    "reset role; set role service_role; select set_config('request.jwt.claim.role','authenticated',false)",
  );
  await expect(
    statement(() =>
      db.query("select public.finalize_verified_file_v2($1,$2,$3,$4::jsonb)", [
        file,
        "a".repeat(64),
        bidder,
        JSON.stringify(context),
      ]),
    ),
  ).rejects.toThrow(/Service role required/);
});
it("filters saved countries before counts/pagination, unknown includes never applied, options ignore own predicate", async () => {
  const file = await prepare();
  await finalize(file);
  await asUser();
  const us = await list({ ipCountry: "US", pageSize: 1 });
  expect(us.total).toBe(1);
  expect(us.rows[0].id).toBe(bid);
  expect(us.statusCounts.applied).toBe(1);
  expect(us.countryOptions).toEqual(["BR", "US"]);
  const nonUS = await list({ ipCountry: "non-US" });
  expect(nonUS.rows.map((row) => row.id)).toEqual([legacyBid]);
  const unknownBid = (
    await db.query<{ id: string }>(
      "select public.save_bid(null,$1,'No Country','Engineer','https://context.test/unknown','Board','remote','open') id",
      [resume],
    )
  ).rows[0].id;
  const unknown = await list({ ipCountry: "unknown" });
  expect(unknown.rows.map((row) => row.id)).toEqual([unknownBid]);
  expect(unknown.rows[0].applicationLocation).toBeNull();
  expect(
    (await list({ ipCountry: "US", pageIndex: 1, pageSize: 1 })).rows,
  ).toEqual([]);
  expect(
    (await list({ ipCountry: "US", search: "Context Company" })).countryOptions,
  ).toEqual(["US"]);
  expect(
    (await list({ ipCountry: "US", status: "applied" })).countryOptions,
  ).toEqual(["US"]);
  // Exercise both ordinary and evidence-sort branches.
  expect(
    (
      await list({
        ipCountry: "US",
        sorting: [{ id: "screenshot_size_bytes", desc: true }],
      })
    ).rows[0].applicationLocation,
  ).toMatchObject({ country: "US" });
});
it("deletes private context through confirmed bid purge", async () => {
  const file = await prepare();
  await finalize(file);
  await asUser();
  await db.query("select public.trash_bid($1,true)", [bid]);
  const version = (
    await db.query<{ version: number }>(
      "select version from public.bids where id=$1",
      [bid],
    )
  ).rows[0].version;
  const operation = (
    await db.query<{ value: { id: string } }>(
      "select public.prepare_bid_purge('selected',$1::jsonb,null) value",
      [JSON.stringify([{ id: bid, version }])],
    )
  ).rows[0].value;
  await db.query("select public.confirm_bid_purge($1)", [operation.id]);
  await db.exec("reset role");
  expect(
    (
      await db.query(
        "select bid_id from public.bid_application_locations where bid_id=$1",
        [bid],
      )
    ).rows,
  ).toEqual([]);
});
it("deletes private context through retention without copying network values into retained aggregates", async () => {
  const file = await prepare();
  await finalize(file);
  await db.exec("reset role");
  await db.query(
    "update public.bids set applied_at=clock_timestamp()-interval '5 months',first_applied_at=clock_timestamp()-interval '5 months' where id=$1",
    [bid],
  );
  await service();
  const result = (
    await db.query<{ value: { deletedApplications: number } }>(
      "select public.process_candidate_retention(10) value",
    )
  ).rows[0].value;
  expect(result.deletedApplications).toBe(1);
  await db.exec("reset role");
  expect(
    (
      await db.query(
        "select bid_id from public.bid_application_locations where bid_id=$1",
        [bid],
      )
    ).rows,
  ).toEqual([]);
  const aggregates = (
    await db.query<{ value: Record<string, unknown> }>(
      "select to_jsonb(a) value from public.retained_bid_daily_aggregates a where profile_id=$1",
      [profile],
    )
  ).rows;
  expect(aggregates.length).toBeGreaterThan(0);
  for (const aggregate of aggregates)
    expect(
      Object.keys(aggregate.value).some((key) =>
        /ip|city|region|country|context/.test(key),
      ),
    ).toBe(false);
});
it("deletes private context through a scoped application-library reset while cutover is active", async () => {
  const file = await prepare();
  await finalize(file);
  await service();
  const inventory = (
    await db.query<{ value: { fingerprint: string } }>(
      "select public.application_library_inventory(array[$1::uuid]) value",
      [workspace],
    )
  ).rows[0].value;
  await db.query("select public.set_application_library_cutover(true)");
  await db.query(
    "select public.reset_application_library(array[$1::uuid],$2,$3)",
    [workspace, inventory.fingerprint, admin],
  );
  await db.exec("reset role");
  expect(
    (
      await db.query(
        "select bid_id from public.bid_application_locations where workspace_id=$1",
        [workspace],
      )
    ).rows,
  ).toEqual([]);
});
it("does not accept shortened IPv4 notation as a validated request IP", async () => {
  for (const ip of ["127.1", "123", "001.002.003.004"]) {
    const file = await prepare();
    await finalize(file, bidder, { ...context, ip });
    await asUser();
    expect(await current()).toMatchObject({
      ip: null,
      city: null,
      source: "unavailable",
      status: "unavailable",
    });
  }
});
