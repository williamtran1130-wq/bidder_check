import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { formatInTimeZone } from "date-fns-tz";

let db: PGlite;
const client = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const bidder = "00000000-0000-4000-8000-000000000003";
let workspace: string, resume: string, bid: string, file: string;
async function asUser(id: string) {
  await db.exec(
    `reset role; set role authenticated; select set_config('request.jwt.claim.sub','${id}',false); select set_config('request.jwt.claim.role','authenticated',false);`,
  );
}
async function managerBidRate(id: string, restoreActor = bidder): Promise<number | null> {
  await asUser(client);
  const values = (await db.query<{ values: { bids: Record<string, number | null> } }>(
    "select public.manager_financial_values('{}','{}',array[$1]::uuid[]) values", [id],
  )).rows[0].values;
  await asUser(restoreActor);
  return values.bids[id];
}
async function finalizeResumeFile(resumeId: string, actor = client): Promise<string> {
  await asUser(actor);
  const upload = (
    await db.query<{ id: string }>(
      "select public.prepare_file('resume',$1,'resume.pdf','application/pdf',100) id",
      [resumeId],
    )
  ).rows[0].id;
  await db.exec("reset role");
  await db.query("select public.finalize_verified_file($1,$2,$3)", [
    upload,
    "b".repeat(64),
    actor,
  ]);
  return upload;
}
async function approveBidAsClient(bidId: string) {
  await asUser(client);
  const version = (
    await db.query<{ version: number }>("select version from public.bids where id=$1", [bidId])
  ).rows[0].version;
  await db.query("select public.review_bid($1,'approved',null,$2)", [bidId, version]);
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth; create schema storage;
 create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}', email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
 alter table storage.objects enable row level security;
 grant usage on schema auth, storage to authenticated, service_role;
 grant all on storage.objects to authenticated,service_role;
 `);
  for (const file of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  }
  await db.query(
    "insert into auth.users(id,email) values ($1,'client@test.com'),($2,'other@test.com')",
    [client, other],
  );
  await db.exec(`do $$ begin
    if exists(select 1 from information_schema.columns where table_name='profiles' and column_name='approval_status') then
      update public.profiles set approval_status='approved';
    end if;
  end $$;`);
  await asUser(client);
  workspace = (
    await db.query<{ id: string }>("select id from public.workspaces")
  ).rows[0].id;
  await db.query(
    "select public.invite_bidder($1,'bidder@test.com','Jordan',125)",
    [workspace],
  );
  await db.exec("reset role");
  await db.query(
    "update public.invitations set id=$1 where email='bidder@test.com'",
    [bidder],
  );
  await db.query(
    "insert into auth.users(id,email,raw_app_meta_data) select $1,'bidder@test.com',jsonb_build_object('bidder_provisioning_id',id) from public.invitations where email='bidder@test.com'",
    [bidder],
  );
  await asUser(client);
  const profileId = (
    await db.query<{ id: string }>(
      "select public.save_candidate_profile(null,$1,'ENG-01','Jordan','','','Instructions') id",
      [workspace],
    )
  ).rows[0].id;
  resume = (
    await db.query<{ id: string }>(
      "select public.save_resume_assignment(null,$1,$2,'jordan@test.com','555-1000',null,null) as id",
      [profileId, bidder],
    )
  ).rows[0].id;
  const resumeUpload = (
    await db.query<{ id: string }>(
      "select public.prepare_file('resume',$1,'resume.pdf','application/pdf',100) id",
      [resume],
    )
  ).rows[0].id;
  await db.exec("reset role; set role service_role");
  await db.query("select public.finalize_verified_file($1,$2,$3)", [
    resumeUpload,
    "b".repeat(64),
    client,
  ]);
  await asUser(bidder);
  bid = (
    await db.query<{ id: string }>(
      "select public.save_bid(null,$1,'Acme','Engineer','https://example.com/jobs?id=1&utm_source=x','LinkedIn','remote','open') as id",
      [resume],
    )
  ).rows[0].id;
  await approveBidAsClient(bid);
  await asUser(bidder);
}, 60000);
afterAll(async () => {
  await db?.close();
});
it("loads bidder-scoped resume counts with authenticated manager grants and financial boundaries", async () => {
  await asUser(client);
  const expected = (await db.query<{ count: number }>(
    "select count(id)::integer count from public.bids where resume_id=$1", [resume],
  )).rows[0].count;
  const counts = (await db.query<{ counts: Record<string, number> }>(
    "select public.resume_bid_counts_for_bidder($1) counts", [bidder],
  )).rows[0].counts;
  expect(counts).toEqual({ [resume]: expected });
  const privileges = (await db.query<{ internal: boolean; anon: boolean; financial: boolean; definer: boolean }>(
    `select has_function_privilege('authenticated','public.require_manager(uuid)','execute') internal,
      has_function_privilege('anon','public.resume_bid_counts_for_bidder(uuid)','execute') anon,
      has_column_privilege('authenticated','public.bids','rate_cents','select') financial,
      (select prosecdef from pg_proc where oid='public.resume_bid_counts_for_bidder(uuid)'::regprocedure) definer`,
  )).rows[0];
  expect(privileges).toEqual({ internal: false, anon: false, financial: false, definer: false });
  for (const [table, column] of [
    ["bidders", "default_rate_cents"], ["resumes", "rate_override_cents"],
    ["bids", "rate_cents"], ["retained_bid_daily_aggregates", "earned_cents"],
    ["bid_events", "details"],
  ]) {
    await expect(db.query(`select ${column} from public.${table} limit 1`)).rejects.toMatchObject({ code: "42501" });
  }
});
it("keeps bidder-scoped resume counts manager-only and allows authorized administrators", async () => {
  await asUser(bidder);
  await expect(db.query("select public.resume_bid_counts_for_bidder($1)", [bidder])).rejects.toThrow(/Access denied/);
  await asUser(other);
  await expect(db.query("select public.resume_bid_counts_for_bidder($1)", [bidder])).rejects.toThrow(/Bidder not found|Access denied/);
  await db.exec("reset role");
  await db.query("update public.profiles set role='admin' where id=$1", [other]);
  try {
    await asUser(other);
    const counts = (await db.query<{ counts: Record<string, number> }>(
      "select public.resume_bid_counts_for_bidder($1) counts", [bidder],
    )).rows[0].counts;
    expect(Object.keys(counts)).toEqual([resume]);
    expect(counts[resume]).toBeGreaterThan(0);
  } finally {
    await db.exec("reset role");
    await db.query("update public.profiles set role='client' where id=$1", [other]);
  }
});
it("keeps invitations pending until email confirmation and supports retries", async () => {
  await asUser(client);
  const pending = await db.query<{ accepted_at: string | null }>(
    "select accepted_at from public.invitations where email='bidder@test.com'",
  );
  expect(pending.rows[0].accepted_at).toBeNull();
  await expect(
    db.query("select public.invite_bidder($1,'bidder@test.com','Jordan',125)", [
      workspace,
    ]),
  ).resolves.toBeDefined();
  await asUser(other);
  const otherWorkspace = (
    await db.query<{ id: string }>("select id from public.workspaces")
  ).rows[0].id;
  await expect(
    db.query("select public.invite_bidder($1,'bidder@test.com','Hijack',500)", [
      otherWorkspace,
    ]),
  ).rejects.toThrow();
  await db.exec("reset role");
  await db.query("update auth.users set email_confirmed_at=now() where id=$1", [
    bidder,
  ]);
  await asUser(client);
  expect(
    (
      await db.query<{ accepted_at: string | null }>(
        "select accepted_at from public.invitations where email='bidder@test.com'",
      )
    ).rows[0].accepted_at,
  ).not.toBeNull();
});
it("private storage is tenant scoped and immutable", async () => {
  await asUser(bidder);
  const upload = (
    await db.query<{ id: string }>(
      "select public.prepare_file('screenshot',$1,'test.png','image/png',100) as id",
      [bid],
    )
  ).rows[0].id;
  const path = (
    await db.query<{ storage_path: string }>(
      "select storage_path from public.files where id=$1",
      [upload],
    )
  ).rows[0].storage_path;
  await db.query(
    "insert into storage.objects(bucket_id,name) values('private-files',$1)",
    [path],
  );
  await asUser(other);
  expect(
    (await db.query("select * from storage.objects where name=$1", [path]))
      .rows,
  ).toHaveLength(0);
  await expect(
    db.query(
      "insert into storage.objects(bucket_id,name) values('private-files',$1)",
      [path + "/fake"],
    ),
  ).rejects.toThrow();
  await asUser(bidder);
  expect(
    (
      await db.query(
        "update storage.objects set metadata='{}' where name=$1 returning id",
        [path],
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await db.query("delete from storage.objects where name=$1 returning id", [
        path,
      ])
    ).rows,
  ).toHaveLength(0);
});
it("isolates tenants and protects roles from direct writes", async () => {
  await asUser(other);
  expect((await db.query("select id from public.bids")).rows).toHaveLength(0);
  expect((await db.query("select id from public.resumes")).rows).toHaveLength(0);
  await expect(
    db.query("update public.profiles set role='admin' where id=$1", [other]),
  ).rejects.toThrow();
  await expect(
    db.query("select public.set_applied($1,false,null,'correction')", [bid]),
  ).rejects.toThrow();
});
it("prevents bidder editing resume and duplicate normalized jobs", async () => {
  await asUser(bidder);
  await expect(
    db.query(
      "select public.save_resume($1,$2,$3,'ENG-01','bad','','','','','',null)",
      [resume, workspace, bidder],
    ),
  ).rejects.toThrow();
  await expect(
    db.query(
      "select public.save_bid(null,$1,'Acme','Engineer','https://EXAMPLE.com/jobs?utm_campaign=x&id=1','Indeed','remote','open')",
      [resume],
    ),
  ).rejects.toThrow();
});
it("normalizes equivalent raw-RPC URLs before enforcing uniqueness", async () => {
  await asUser(bidder);
  for (const url of [
    "https://example.com:443/jobs?id=1",
    "https://example.com/a/../jobs?id=1",
    "https://example.com/jobs?%75tm_source=x&id=1",
    "https://example.com/jobs?%69d=1",
  ]) {
    await expect(
      db.query(
        "select public.save_bid(null,$1,'Acme','Engineer',$2,'Indeed','remote','open')",
        [resume, url],
      ),
    ).rejects.toThrow();
  }
});
it("validates a 476-row import against a profile with 10,000 retained bids within the statement budget", async () => {
  await db.exec("reset role");
  await db.query(
    `insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,arrangement,job_status,review_status)
     select r.workspace_id,r.bidder_id,r.id,'Seed Company '||n,'Seed Role','https://seed.example/jobs/'||n,'https://seed.example/jobs/'||n,'remote','open','approved'
     from public.resumes r cross join generate_series(1,10000) n where r.id=$1`,
    [resume],
  );
  const rows = Array.from({ length: 476 }, (_, index) => ({
    company: `Load Company ${index + 1}`,
    role_name: "Software Engineer",
    url: `https://load.example/jobs/${index + 1}`,
    source: "Test",
    arrangement: "remote",
    job_status: "open",
  }));
  await asUser(bidder);
  const started = performance.now();
  const result = await db.query<{ errors: unknown[] }>(
    "select public.validate_bid_import($1,$2,$3::jsonb) errors",
    [resume, formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd"), JSON.stringify(rows)],
  );
  const elapsed = performance.now() - started;
  expect(result.rows[0].errors).toEqual([]);
  // This local guard catches per-row rescans; hosted performance is checked separately.
  expect(elapsed).toBeLessThan(8000);
  const listingStarted = performance.now();
  const page = (await db.query<{ result: { rows: unknown[]; total: number } }>(
    "select public.list_bids($1::jsonb) result",
    [JSON.stringify({ trash: false, pageIndex: 0, pageSize: 25, sorting: [{ id: "found_at", desc: true }], columnFilters: {}, search: "" })],
  )).rows[0].result;
  const listingElapsed = performance.now() - listingStarted;
  expect(page.rows).toHaveLength(25);
  expect(page.total).toBeGreaterThanOrEqual(10000);
  expect(listingElapsed).toBeLessThan(2000);
  await db.exec("reset role");
  await db.query("delete from public.bids where resume_id=$1 and company like 'Seed Company %'", [resume]);
});
it("evaluates the readable bid scope from trusted memberships and keeps list_bids invoker-scoped", async () => {
  await asUser(bidder);
  const scope = await db.query<{ workspace_id: string; bidder_id: string }>(
    "select workspace_id,bidder_id from private.readable_bid_scope()",
  );
  expect(scope.rows).toEqual([{ workspace_id: workspace, bidder_id: bidder }]);
  const policyScope = await db.query<{ workspace_id: string; bidder_id: string }>(
    "select distinct b.workspace_id,b.bidder_id from public.bids b",
  );
  expect(policyScope.rows).toEqual([{ workspace_id: workspace, bidder_id: bidder }]);
  expect((await db.query<{ allowed: boolean }>(
    "select has_function_privilege('anon','private.readable_bid_scope()','execute') allowed",
  )).rows[0].allowed).toBe(false);
  expect((await db.query<{ allowed: boolean }>(
    "select has_function_privilege('authenticated','private.readable_bid_scope()','execute') allowed",
  )).rows[0].allowed).toBe(true);

  await asUser(client);
  const managedScope = await db.query<{ workspace_id: string; bidder_id: string }>(
    "select workspace_id,bidder_id from private.readable_bid_scope()",
  );
  expect(managedScope.rows).toContainEqual({ workspace_id: workspace, bidder_id: bidder });
  const listed = (await db.query<{ result: { total: number; rows: unknown[] } }>(
    "select public.list_bids($1::jsonb) result",
    [JSON.stringify({ trash: false, rangeFrom: null, rangeTo: null, pageIndex: 0, pageSize: 10, columnFilters: {}, search: "" })],
  )).rows[0].result;
  expect(listed.total).toBeGreaterThan(0);
  expect(listed.rows.length).toBeLessThanOrEqual(10);
});
it("enforces profile-wide company limits and literal restrictions", async () => {
  await asUser(client);
  const profileId = (
    await db.query<{ id: string }>(
      "select public.save_candidate_profile(null,$1,'LIMIT-01','Limit Candidate','','','') id",
      [workspace],
    )
  ).rows[0].id;
  const assignment = (
    await db.query<{ id: string }>(
      "select public.save_resume_assignment(null,$1,$2,'limit@test.com','555-1111',null,null) id",
      [profileId, bidder],
    )
  ).rows[0].id;
  await finalizeResumeFile(assignment);
  await asUser(client);
  const companies = Array.from({ length: 249 }, (_, index) => `Blocked Company ${index}`);
  companies.push("Acme");
  await db.query(
    "select public.update_candidate_profile_rules($1,1,3,$2::text[],array['Staff Engineer'],array['blocked.example'])",
    [profileId, [...companies, " ACME "]],
  );
  const stored = (await db.query<{ restricted_companies: string[] }>(
    "select restricted_companies from public.candidate_profiles where id=$1", [profileId],
  )).rows[0].restricted_companies;
  expect(stored).toHaveLength(250);
  expect(stored[0]).toBe("blocked company 0");
  expect(stored[249]).toBe("acme");
  await asUser(bidder);
  await db.query(
    "select public.save_bid(null,$1,'Northwind','Engineer','https://northwind.test/job/1','LinkedIn','remote','open')",
    [assignment],
  );
  await expect(
    db.query(
      "select public.save_bid(null,$1,'Northwind','Designer','https://northwind.test/job/2','LinkedIn','remote','open')",
      [assignment],
    ),
  ).rejects.toMatchObject({ message: "Blocked", code: "PBC01" });
  await expect(
    db.query(
      "select public.save_bid(null,$1,'Acme Laboratories','Engineer','https://acme.test/job/3','LinkedIn','remote','open')",
      [assignment],
    ),
  ).rejects.toMatchObject({ message: "Blocked", code: "PBC01" });
  const previewErrors = (
    await db.query<{ errors: { row: number; code: string }[] }>(
      "select public.validate_bid_import($1,'2026-03-08',$2::jsonb) errors",
      [assignment, JSON.stringify([
        { company: "Acme Industries", role_name: "Engineer", url: "https://acme.test/1", source: "", arrangement: "remote", job_status: "open" },
        { company: "Blue", role_name: "Engineer", url: "https://blue.test/1", source: "", arrangement: "remote", job_status: "open" },
        { company: "Blue", role_name: "Designer", url: "https://blue.test/2", source: "", arrangement: "remote", job_status: "open" },
      ])],
    )
  ).rows[0].errors;
  expect(previewErrors.map((issue) => issue.row)).toEqual([1, 3]);
  await db.exec("reset role");
  await db.exec(`delete from public.bid_events where bid_id in (select id from public.bids where resume_id='${assignment}'); delete from public.bids where resume_id='${assignment}'; update public.resumes set file_id=null where id='${assignment}'; delete from public.files where resume_id='${assignment}'; delete from public.resumes where id='${assignment}'; delete from public.candidate_profiles where id='${profileId}';`);
});
it("bulk review is atomic and rejects stale selected versions", async () => {
  await asUser(bidder);
  const first = (await db.query<{ id: string }>("select public.save_bid(null,$1,'Review One','Engineer','https://review.test/one','Indeed','remote','open') id", [resume])).rows[0].id;
  const second = (await db.query<{ id: string }>("select public.save_bid(null,$1,'Review Two','Engineer','https://review.test/two','Indeed','remote','open') id", [resume])).rows[0].id;
  await asUser(client);
  const versions = (await db.query<{id:string;version:number}>("select id,version from public.bids where id=any($1::uuid[]) order by id", [[first,second]])).rows;
  const stale = versions.map((row,index)=>({id:row.id,version:row.version+(index===1?1:0)}));
  await expect(db.query("select public.review_bids($1::jsonb,'approved','')", [JSON.stringify(stale)])).rejects.toThrow(/changed/i);
  const unchanged=(await db.query<{review_status:string}>("select review_status from public.bids where id=any($1::uuid[])",[ [first,second] ])).rows;
  expect(unchanged.every(row=>row.review_status==="pending")).toBe(true);
  await db.query("select public.review_bids($1::jsonb,'approved','')",[JSON.stringify(versions)]);
  const approved=(await db.query<{review_status:string}>("select review_status from public.bids where id=any($1::uuid[])",[ [first,second] ])).rows;
  expect(approved.every(row=>row.review_status==="approved")).toBe(true);
  await db.exec("reset role");
  await db.query("delete from public.bid_events where bid_id=any($1::uuid[])",[[first,second]]);
  await db.query("delete from public.bids where id=any($1::uuid[])",[[first,second]]);
});

it("verified uploads apply atomically, replace proof, reject corrected content and preserve earnings", async () => {
  await asUser(bidder);
  await expect(
    db.query("select public.set_applied($1,true,null,null)", [bid]),
  ).rejects.toThrow();
  const prepare = async () =>
    (
      await db.query<{ id: string }>(
        "select public.prepare_file('screenshot',$1,'proof.png','image/png',100) id",
        [bid],
      )
    ).rows[0].id;
  const finish = async (id: string, hash: string) => {
    await db.exec("reset role; set role service_role");
    return db.query("select public.finalize_verified_file($1,$2,$3)", [
      id,
      hash.repeat(64),
      bidder,
    ]);
  };
  file = await prepare();
  await finish(file, "a");
  await asUser(bidder);
  const first = (
    await db.query<{
      applied: boolean;
      first_applied_at: string;
      applied_at: string;
    }>("select applied,first_applied_at,applied_at from public.bids where id=$1", [bid])
  ).rows[0];
  expect(first.applied).toBe(true);
  expect(await managerBidRate(bid)).toBe(125);
  const replacement = await prepare();
  await finish(replacement, "b");
  await finish(replacement, "b");
  await asUser(bidder);
  const replaced = (
    await db.query<typeof first>("select applied,first_applied_at,applied_at from public.bids where id=$1", [bid])
  ).rows[0];
  expect(replaced.first_applied_at).toEqual(first.first_applied_at);
  expect(new Date(replaced.applied_at).getTime()).toBeGreaterThan(
    new Date(first.applied_at).getTime(),
  );
  expect(
    (
      await db.query(
        "select id,event from public.bid_events where event='proof_replaced' and bid_id=$1",
        [bid],
      )
    ).rows,
  ).toHaveLength(1);
  await expect(
    db.query("select public.set_applied($1,false,null,'bad')", [bid]),
  ).rejects.toThrow("Access denied");
  await asUser(client);
  await db.query("select public.update_bidder($1,'Jordan',999,false)", [
    bidder,
  ]);
  await expect(
    db.query("select public.set_applied($1,false,null,'')", [bid]),
  ).rejects.toThrow();
  await db.query(
    "select public.set_applied($1,false,null,'Wrong confirmation')",
    [bid],
  );
  await asUser(bidder);
  const rejected = await prepare();
  await expect(finish(rejected, "b")).rejects.toThrow("previously rejected");
  await asUser(bidder);
  expect(
    (
      await db.query<{ finalized: boolean }>(
        "select finalized from public.files where id=$1",
        [rejected],
      )
    ).rows[0].finalized,
  ).toBe(false);
  const fresh = await prepare();
  await finish(fresh, "c");
  await asUser(bidder);
  expect(await managerBidRate(bid)).toBe(125);
});
it("dashboard reporting combines live CT cohorts and reports interview conversion by assignment", async () => {
  const today = formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd");
  await asUser(client);
  await db.query(
    "select public.set_bid_interview($1,true,clock_timestamp(),'Panel interview','')",
    [bid],
  );
  const profileId = (await db.query<{ profile_id: string }>(
    "select profile_id from public.resumes where id=$1", [resume],
  )).rows[0].profile_id;
  const result = (await db.query<{ report: {
    daily: { date: string; found: number; foundApplied: number; applied: number; earningsCents: number }[];
    totals: { found: number; foundApplied: number; trackedApplications: number; trackedInterviews: number };
    groups: { key: string; applied: number; interviews: number; conversion: number | null }[];
  } }>(
    "select public.dashboard_performance($1,$1,$2,null,$3,'assignment') report",
    [today, workspace, profileId],
  )).rows[0].report;
  expect(result.daily).toHaveLength(1);
  expect(result.daily[0].date).toBe(today);
  expect(result.daily[0].found).toBeGreaterThanOrEqual(1);
  expect(result.totals.foundApplied).toBeGreaterThanOrEqual(1);
  expect(result.totals.trackedApplications).toBeGreaterThanOrEqual(1);
  expect(result.totals.trackedInterviews).toBeGreaterThanOrEqual(1);
  expect(result.groups).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: `${profileId}:${bidder}`, applied: 1, interviews: 1, conversion: 100 }),
  ]));
});
it("revokes archived bidder access but retains client history", async () => {
  await asUser(client);
  await db.query("select public.update_bidder($1,'Jordan',125,true)", [bidder]);
  await asUser(bidder);
  expect((await db.query("select id from public.bids")).rows).toHaveLength(0);
  await expect(
    db.query("select public.set_applied($1,false,null,'undo')", [bid]),
  ).rejects.toThrow();
  await asUser(client);
  expect((await db.query("select id from public.bids")).rows).toHaveLength(1);
});
it("ignores client-supplied role metadata on signup", async () => {
  await db.exec("reset role");
  const attacker = "00000000-0000-4000-8000-000000000009";
  await db.query(
    'insert into auth.users(id,email,raw_user_meta_data) values($1,\'attacker@test.com\',\'{"role":"admin","workspace_id":"anything"}\')',
    [attacker],
  );
  await asUser(attacker);
  expect(
    (
      await db.query<{ role: string }>(
        "select role from public.profiles where id=$1",
        [attacker],
      )
    ).rows[0].role,
  ).toBe("client");
  expect((await db.query("select id from public.bids")).rows).toHaveLength(0);
});
it("isolates peers, accepts explicit zero rates, and locks applied resume assignment", async () => {
  await asUser(client);
  const peer = "00000000-0000-4000-8000-000000000004";
  await db.query(
    "select public.invite_bidder($1,'peer@test.com','Peer',null)",
    [workspace],
  );
  await db.exec("reset role");
  await db.query(
    "update public.invitations set id=$1 where email='peer@test.com'",
    [peer],
  );
  await db.query(
    "insert into auth.users(id,email,raw_app_meta_data) select $1,'peer@test.com',jsonb_build_object('bidder_provisioning_id',id) from public.invitations where email='peer@test.com'",
    [peer],
  );
  await asUser(client);
  const r = (
    await db.query<{ id: string }>(
      "select public.save_resume(null,$1,$2,'PEER-01','Peer','peer1@test.com','555-2001','','','',null) id",
      [workspace, peer],
    )
  ).rows[0].id;
  const r2 = (
    await db.query<{ id: string }>(
      "select public.save_resume(null,$1,$2,'PEER-02','Peer','peer2@test.com','555-2002','','','',0) id",
      [workspace, peer],
    )
  ).rows[0].id;
  await finalizeResumeFile(r);
  await finalizeResumeFile(r2);
  await asUser(peer);
  expect(
    (await db.query("select id from public.bids where id=$1", [bid])).rows,
  ).toHaveLength(0);
  await expect(
    db.query(
      "select public.prepare_file('resume',$1,'file.pdf','application/pdf',100)",
      [r],
    ),
  ).rejects.toThrow();
  const fresh = (
    await db.query<{ id: string }>(
      "select public.save_bid(null,$1,'Acme','Engineer','https://example.com/jobs?id=1','Indeed','remote','open') id",
      [r],
    )
  ).rows[0].id;
  await approveBidAsClient(fresh);
  await asUser(peer);
  const proof = (
    await db.query<{ id: string }>(
      "select public.prepare_file('screenshot',$1,'proof.png','image/png',100) id",
      [fresh],
    )
  ).rows[0].id;
  await db.exec("reset role;set role service_role");
  await expect(
    db.query("select public.finalize_verified_file($1,$2,$3)", [
      proof,
      "d".repeat(64),
      peer,
    ]),
  ).rejects.toThrow("configure a bid rate");
  await asUser(client);
  await db.query(
    "select public.save_resume($1,$2,$3,'PEER-01','Peer','peer1@test.com','555-2001','','','',0)",
    [r, workspace, peer],
  );
  await db.exec("reset role;set role service_role");
  await Promise.all([
    db.query("select public.finalize_verified_file($1,$2,$3)", [
      proof,
      "d".repeat(64),
      peer,
    ]),
    db.query("select public.finalize_verified_file($1,$2,$3)", [
      proof,
      "d".repeat(64),
      peer,
    ]),
  ]);
  await asUser(peer);
  expect(await managerBidRate(fresh, peer)).toBe(0);
  expect(
    (
      await db.query(
        "select id,event from public.bid_events where bid_id=$1 and event='applied'",
        [fresh],
      )
    ).rows,
  ).toHaveLength(1);
  await expect(
    db.query(
      "select public.save_bid($1,$2,'Acme','Engineer','https://example.com/jobs?id=1','Indeed','remote','open')",
      [fresh, r2],
    ),
  ).rejects.toThrow("resume assignment");
});
it("bidder provisioning requires a server-assigned Auth identity and rejects signup metadata", async () => {
  await asUser(client);
  await db.query(
    "select public.invite_bidder($1,'reserved@test.com','Reserved',100)",
    [workspace],
  );
  await db.exec("reset role");
  const reserved = (
    await db.query<{ id: string }>(
      "select id from public.invitations where email='reserved@test.com'",
    )
  ).rows[0].id;
  await expect(
    db.query(
      "insert into auth.users(id,email,raw_user_meta_data) values(gen_random_uuid(),'reserved@test.com',$1)",
      [JSON.stringify({ bidder_provisioning_id: reserved })],
    ),
  ).rejects.toThrow("reserved");
  const created = reserved;
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'reserved@test.com',now())",
    [created],
  );
  expect(
    (
      await db.query<{ role: string }>(
        "select role from public.profiles where id=$1",
        [created],
      )
    ).rows[0].role,
  ).toBe("bidder");
  expect(
    (
      await db.query<{ accepted_at: string }>(
        "select accepted_at from public.invitations where id=$1",
        [reserved],
      )
    ).rows[0].accepted_at,
  ).not.toBeNull();
});
it("admin can manage clients and archived client access is revoked", async () => {
  await db.exec("reset role");
  const admin = "00000000-0000-4000-8000-000000000005";
  await db.query(
    "insert into auth.users(id,email) values($1,'admin@test.com')",
    [admin],
  );
  await db.query("update public.profiles set role='admin' where id=$1", [
    admin,
  ]);
  await asUser(admin);
  expect(
    (await db.query("select id from public.bids")).rows.length,
  ).toBeGreaterThan(1);
  await db.query("select public.update_client($1,'Client',true)", [client]);
  await asUser(client);
  expect((await db.query("select id from public.bids")).rows).toHaveLength(0);
  await asUser("00000000-0000-4000-8000-000000000004");
  expect((await db.query("select id from public.bids")).rows).toHaveLength(0);
  await asUser(admin);
  expect(
    (await db.query("select id from public.bids")).rows.length,
  ).toBeGreaterThan(1);
});

it("public signup remains pending despite forged approval metadata and has no workspace access", async () => {
  await db.exec("reset role");
  const pending = "00000000-0000-4000-8000-000000000020";
  await db.query(
    "insert into auth.users(id,email,raw_user_meta_data) values($1,'pending@test.com',$2)",
    [pending, JSON.stringify({ approval_status: "approved", role: "admin" })],
  );
  await asUser(pending);
  const profile = (
    await db.query<{ approval_status: string }>(
      "select * from public.profiles where id=$1",
      [pending],
    )
  ).rows[0];
  expect(profile.approval_status).toBe("pending");
  expect((await db.query("select * from public.workspaces")).rows).toHaveLength(
    0,
  );
  await expect(
    db.query("select public.invite_bidder($1,'bad@test.com','Bad',1)", [
      workspace,
    ]),
  ).rejects.toThrow("Access denied");
});

it("only admins approve or reject clients and rejection needs a reason", async () => {
  const pending = "00000000-0000-4000-8000-000000000020";
  await asUser(pending);
  await expect(
    db.query("select public.review_client($1,'approved',null)", [pending]),
  ).rejects.toThrow();
  await asUser("00000000-0000-4000-8000-000000000005");
  await expect(
    db.query("select public.review_client($1,'rejected','')", [pending]),
  ).rejects.toThrow();
  await db.query("select public.review_client($1,'rejected','Needs review')", [
    pending,
  ]);
  await asUser(pending);
  expect(
    (
      await db.query<{ approval_reason: string }>(
        "select approval_reason from public.profiles where id=$1",
        [pending],
      )
    ).rows[0].approval_reason,
  ).toBe("Needs review");
  expect((await db.query("select * from public.workspaces")).rows).toHaveLength(
    0,
  );
  await asUser("00000000-0000-4000-8000-000000000005");
  await db.query("select public.review_client($1,'approved',null)", [pending]);
  await asUser(pending);
  expect((await db.query("select * from public.workspaces")).rows).toHaveLength(
    1,
  );
});

it("active bids reserve duplicates while Trash releases them and conflicts block restoration", async () => {
  let testProfile: string | undefined;
  let testResume: string | undefined;
  let firstBid: string | undefined;
  let replacement: string | undefined;
  let resumeFile: string | undefined;
  try {
    await asUser("00000000-0000-4000-8000-000000000005");
    await db.query("select public.update_client($1,'Client',false)", [client]);
    await asUser(client);
    await db.query("select public.update_bidder($1,'Jordan',125,false)", [bidder]);
    testProfile = (
      await db.query<{ id: string }>(
        "select public.save_candidate_profile(null,$1,'ACTIVE-ONLY','Jordan','','','') id",
        [workspace],
      )
    ).rows[0].id;
    await db.query(
      "select public.update_candidate_profile_rules($1,1,3,'{}','{}','{}',null)",
      [testProfile],
    );
    testResume = (
      await db.query<{ id: string }>(
        "select public.save_resume_assignment(null,$1,$2,'active-only@test.com','555-1111',null,null) id",
        [testProfile, bidder],
      )
    ).rows[0].id;
    resumeFile = await finalizeResumeFile(testResume);
    await asUser(bidder);
    firstBid = (
      await db.query<{ id: string }>(
        "select public.save_bid(null,$1,'Acme','Engineer','https://example.com/active-only?id=1','Indeed','remote','open') id",
        [testResume],
      )
    ).rows[0].id;

    await expect(
      db.query(
        "select public.save_bid(null,$1,' ACME  ',' Engineer ','https://example.com/active-only?id=3','Indeed','remote','open')",
        [testResume],
      ),
    ).rejects.toMatchObject({ message: "Blocked", code: "PBC01" });

    // Active company capacity is enforced, then released immediately by Trash.
    await expect(
      db.query(
        "select public.save_bid(null,$1,'ACME','Engineer II','https://example.com/active-only?id=2','Indeed','remote','open')",
        [testResume],
      ),
    ).rejects.toMatchObject({ message: "Blocked", code: "PBC01" });
    await db.query("select public.trash_bid($1,true)", [firstBid]);
    replacement = (
      await db.query<{ id: string }>(
        "select public.save_bid(null,$1,'ACME','Engineer','https://example.com/active-only?id=1','Indeed','remote','open') id",
        [testResume],
      )
    ).rows[0].id;

    const trashedVersion = (
      await db.query<{ version: number }>(
        "select version from public.bids where id=$1",
        [firstBid],
      )
    ).rows[0].version;
    await expect(
      db.query("select public.bulk_bid_state($1::jsonb,false)", [
        JSON.stringify([{ id: firstBid, version: trashedVersion }]),
      ]),
    ).rejects.toThrow("Restoration blocked");
    expect(
      (
        await db.query<{ deleted_at: string | null }>("select deleted_at from public.bids where id=$1", [firstBid])
      ).rows[0].deleted_at,
    ).not.toBeNull();
    await db.query("select public.trash_bid($1,true)", [replacement]);
    const versions = (
      await db.query<{ id: string; version: number }>(
        "select id,version from public.bids where id=any($1::uuid[]) order by id",
        [[firstBid, replacement]],
      )
    ).rows;
    await expect(
      db.query("select public.bulk_bid_state($1::jsonb,false)", [JSON.stringify(versions)]),
    ).rejects.toThrow("Restoration blocked");
    expect(
      (
        await db.query<{ count: string }>(
          "select count(*)::text count from public.bids where id=any($1::uuid[]) and deleted_at is not null",
          [[firstBid, replacement]],
        )
      ).rows[0].count,
    ).toBe("2");
    const firstVersion = versions.find((row) => row.id === firstBid)!.version;
    await db.query("select public.bulk_bid_state($1::jsonb,false)", [
      JSON.stringify([{ id: firstBid, version: firstVersion }]),
    ]);
  } finally {
    await db.exec("reset role; set role service_role");
    if (testProfile) {
      await db.query("delete from public.bid_events where bid_id=any($1::uuid[])", [
        [firstBid, replacement].filter(Boolean),
      ]);
      await db.query("delete from public.bids where id=any($1::uuid[])", [
        [firstBid, replacement].filter(Boolean),
      ]);
      await db.query("update public.resumes set file_id=null where id=$1", [testResume]);
      await db.query("delete from public.files where resume_id=$1", [testResume]);
      await db.query("delete from public.resumes where id=$1", [testResume]);
      await db.query("delete from public.candidate_profiles where id=$1", [testProfile]);
    }
    void resumeFile;
  }
});
it("found time cannot be supplied or changed through APIs", async () => {
  await asUser(bidder);
  await expect(
    db.query(
      "select public.save_bid(null,$1,'Backdated','Engineer','https://example.com/backdated','Indeed','remote','open','2000-01-01')",
      [resume],
    ),
  ).rejects.toThrow();
  const before = (
    await db.query<{ found_at: string }>(
      "select found_at from public.bids where id=$1",
      [bid],
    )
  ).rows[0].found_at;
  await expect(
    db.query(
      "select public.save_bid($1,$2,'Updated','Engineer','https://example.com/jobs?id=1','Indeed','remote','open')",
      [bid, resume],
    ),
  ).rejects.toThrow(/applied bid details/i);
  expect(
    (
      await db.query<{ found_at: string }>(
        "select found_at from public.bids where id=$1",
        [bid],
      )
    ).rows[0].found_at,
  ).toEqual(before);
  await expect(
    db.query("update public.bids set found_at='2000-01-01' where id=$1", [bid]),
  ).rejects.toThrow();
});
it("managed credentials are scoped and Auth email edits synchronize atomically", async () => {
  await asUser(client);
  expect(
    (
      await db.query<{ allowed: boolean }>(
        "select public.can_manage_account($1) allowed",
        [bidder],
      )
    ).rows[0].allowed,
  ).toBe(true);
  expect(
    (
      await db.query<{ allowed: boolean }>(
        "select public.can_manage_account($1) allowed",
        [other],
      )
    ).rows[0].allowed,
  ).toBe(false);
  await asUser(bidder);
  expect(
    (
      await db.query<{ allowed: boolean }>(
        "select public.can_manage_account($1) allowed",
        [bidder],
      )
    ).rows[0].allowed,
  ).toBe(false);
  await db.exec("reset role");
  await db.query("update auth.users set email='changed@test.com' where id=$1", [
    bidder,
  ]);
  expect(
    (
      await db.query<{ email: string }>(
        "select email from public.profiles where id=$1",
        [bidder],
      )
    ).rows[0].email,
  ).toBe("changed@test.com");
  await expect(
    db.query("update auth.users set email='other@test.com' where id=$1", [
      bidder,
    ]),
  ).rejects.toThrow();
  expect(
    (
      await db.query<{ email: string }>(
        "select email from auth.users where id=$1",
        [bidder],
      )
    ).rows[0].email,
  ).toBe("changed@test.com");
});
it("admin cannot use bidder editing to mutate a client or nonexistent account", async () => {
  await asUser("00000000-0000-4000-8000-000000000005");
  await expect(
    db.query("select public.update_bidder($1,'Wrong target',0,true)", [client]),
  ).rejects.toThrow("Bidder not found");
});
it("an old bidder email can be reused with a fresh identity after an email change", async () => {
  await asUser(other);
  const w = (await db.query<{ id: string }>("select id from public.workspaces"))
    .rows[0].id;
  const reservation = (
    await db.query<{ id: string }>(
      "select public.invite_bidder($1,'bidder@test.com','Replacement',100) id",
      [w],
    )
  ).rows[0].id;
  expect(reservation).not.toBe(bidder);
  await db.exec("reset role");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'bidder@test.com',now())",
    [reservation],
  );
  expect(
    (
      await db.query<{ email: string }>(
        "select email from public.profiles where id=$1",
        [bidder],
      )
    ).rows[0].email,
  ).toBe("changed@test.com");
});

it("pending clients cannot mutate settings through direct RPC", async () => {
  await db.exec("reset role");
  const pending = "00000000-0000-4000-8000-000000000031";
  await db.query(
    "insert into auth.users(id,email) values($1,'settings-pending@test.com')",
    [pending],
  );
  await asUser(pending);
  await expect(
    db.query(
      "select public.save_settings('New name',null,'','America/Chicago')",
    ),
  ).rejects.toThrow("Access denied");
});
it("imports atomically with receipts and version-checks individual cells", async () => {
  await asUser(client);
  const rid = (
    await db.query<{ id: string }>(
      "select public.save_resume(null,$1,$2,'SHEET-01','Jordan','jordan@test.com','555-1001','','','Instructions',null) id",
      [workspace, bidder],
    )
  ).rows[0].id;
  await finalizeResumeFile(rid);
  await asUser(bidder);
  const rows = [
    {
      company: "Sheets Inc",
      role_name: "Engineer",
      url: "https://example.com/sheet/1",
      source: "Google",
      arrangement: "remote",
      job_status: "open",
    },
  ];
  const request = "00000000-0000-4000-8000-000000000099";
  const run = async (values = rows, key = request) =>
    (
      await db.query<{ result: { ids: string[]; errors?: unknown[] } }>(
        "select public.import_bids($1,'2026-03-08',$2::jsonb,$3) result",
        [rid, JSON.stringify(values), key],
      )
    ).rows[0].result;
  const first = await run();
  expect(first.ids).toHaveLength(1);
  expect(await run()).toEqual(first);
  await expect(run([{ ...rows[0], company: "Changed" }])).rejects.toThrow(
    /different content/,
  );
  const b = (
    await db.query<{
      found_at: Date;
      created_at: Date;
      version: number;
      applied: boolean;
    }>("select found_at,created_at,version,applied from public.bids where id=$1", [first.ids[0]])
  ).rows[0];
  expect(new Date(b.found_at).toISOString()).toBe("2026-03-08T06:00:00.000Z");
  expect(b.applied).toBe(false);
  expect(new Date(b.created_at).getTime()).toBeGreaterThan(
    new Date(b.found_at).getTime(),
  );
  const edit = async (version: number, field = "company", value = "Updated") =>
    (
      await db.query<{
        result: {
          ok: boolean;
          conflict?: boolean;
          row: { company: string; version: number };
        };
      }>("select public.update_bid_cell($1,$2,$3,$4) result", [
        first.ids[0],
        field,
        value,
        version,
      ])
    ).rows[0].result;
  expect((await edit(b.version)).ok).toBe(true);
  const stale = await edit(b.version);
  expect(stale.conflict).toBe(true);
  expect(stale.row.company).toBe("Updated");
  await expect(
    edit(stale.row.version, "found_at", "2020-01-01"),
  ).rejects.toThrow(/editable/);
  await asUser(other);
  await expect(edit(stale.row.version)).rejects.toThrow(/Access denied/);
  await asUser(bidder);
  await db.query("select public.trash_bid($1,true)", [first.ids[0]]);
  const duplicate = await run(
    [rows[0]],
    "00000000-0000-4000-8000-000000000098",
  );
  expect(duplicate.errors).toBeUndefined();
  expect(duplicate.ids).toHaveLength(1);
  expect(
    (await db.query("select id from public.bids where normalized_url='https://example.com/sheet/1' and deleted_at is null")).rows,
  ).toHaveLength(1);
  await expect(edit(stale.row.version)).rejects.toThrow(/trash/);
  const invalid = await run(
    [{ ...rows[0], url: "javascript:alert(1)" }],
    "00000000-0000-4000-8000-000000000097",
  );
  expect(invalid.errors?.length).toBeGreaterThan(0);
});
it("imports enforce limits, permissions, dates, receipt privacy and locked resumes", async () => {
  await asUser(bidder);
  const rid = (
    await db.query<{ id: string }>(
      "select id from public.resumes where identifier='SHEET-01'",
    )
  ).rows[0].id;
  const row = {
    company: "A",
    role_name: "R",
    url: "https://example.com/batch/new",
    source: "",
    arrangement: "remote",
    job_status: "open",
  };
  const validate = async (rows: unknown, date = "2026-11-01") =>
    db.query("select public.validate_bid_import($1,$2,$3::jsonb)", [
      rid,
      date,
      JSON.stringify(rows),
    ]);
  await expect(validate([row], "2999-01-01")).rejects.toThrow(/future/);
  await expect(
    validate(
      Array.from({ length: 501 }, () => row),
      "2026-03-08",
    ),
  ).rejects.toThrow(/500/);
  await asUser(other);
  await expect(validate([row], "2026-03-08")).rejects.toThrow(/Access denied/);
  expect(
    (await db.query("select * from public.bid_import_receipts")).rows,
  ).toHaveLength(0);
  await asUser("00000000-0000-4000-8000-000000000005");
  await db.query("select public.update_client($1,'Client',true)", [client]);
  await asUser(bidder);
  expect(
    (await db.query("select * from public.bid_import_receipts")).rows,
  ).toHaveLength(0);
  await expect(validate([row], "2026-03-08")).rejects.toThrow(/Access denied/);
  await asUser("00000000-0000-4000-8000-000000000005");
  await db.query("select public.update_client($1,'Client',false)", [client]);
  await asUser(bidder);
  const applied = (
    await db.query<{ id: string; version: number }>(
      "select id,version from public.bids where first_applied_at is not null and deleted_at is null limit 1",
    )
  ).rows[0];
  await expect(
    db.query("select public.update_bid_cell($1,'resume_id',$2,$3)", [
      applied.id,
      rid,
      applied.version,
    ]),
  ).rejects.toThrow(/locked/);
});
it("canonicalizes raw Unicode/spaces and rejects invalid HTTP authorities in database writes", async () => {
  await db.exec("reset role");
  const normalize = async (url: string) =>
    (
      await db.query<{ u: string }>("select public.normalize_job_url($1) u", [
        url,
      ])
    ).rows[0].u;
  expect(await normalize("https://example.com/r\u00e9sum\u00e9")).toBe(
    await normalize("https://example.com/r%C3%A9sum%C3%A9"),
  );
  expect(await normalize("https://example.com/job here")).toBe(
    await normalize("https://example.com/job%20here"),
  );
  await expect(normalize("https://example.com:99999/job")).rejects.toThrow();
  await expect(normalize("https://127.1/job")).rejects.toThrow();
  expect(await normalize("https://example.com:00444/a")).toBe(
    "https://example.com:444/a",
  );
  await asUser(bidder);
  const rid = (
    await db.query<{ id: string }>(
      "select id from public.resumes where identifier='SHEET-01'",
    )
  ).rows[0].id;
  const id = (
    await db.query<{ id: string }>(
      "select public.save_bid(null,$1,'Unicode','Role','https://example.com/r%C3%A9sum%C3%A9','','remote','open') id",
      [rid],
    )
  ).rows[0].id;
  await db.query("select public.trash_bid($1,true)", [id]);
  const errors = (
    await db.query<{ e: { message: string }[] }>(
      "select public.validate_bid_import($1,'2026-03-08',$2::jsonb) e",
      [
        rid,
        JSON.stringify([
          {
            company: "A",
            role_name: "R",
            url: "https://example.com/r\u00e9sum\u00e9",
            source: "",
            arrangement: "remote",
            job_status: "open",
          },
        ]),
      ],
    )
  ).rows[0].e;
  expect(errors).toEqual([]);
});
it("commits the maximum 500-row batch once and preserves original results on retry", async () => {
  await asUser(bidder);
  const rid = (
    await db.query<{ id: string }>(
      "select id from public.resumes where identifier='SHEET-01'",
    )
  ).rows[0].id;
  const rows = Array.from({ length: 500 }, (_, i) => ({
    company: `Capacity ${i}`,
    role_name: "Engineer",
    url: `https://example.com/capacity/${i}`,
    source: "",
    arrangement: "remote",
    job_status: "open",
  }));
  const args = [
    rid,
    JSON.stringify(rows),
    "00000000-0000-4000-8000-000000000096",
  ];
  const first = (
    await db.query<{ r: { ids: string[] } }>(
      "select public.import_bids($1,'2025-10-01',$2::jsonb,$3) r",
      args,
    )
  ).rows[0].r;
  expect(first.ids).toHaveLength(500);
  expect(
    (
      await db.query<{ r: unknown }>(
        "select public.import_bids($1,'2025-10-01',$2::jsonb,$3) r",
        args,
      )
    ).rows[0].r,
  ).toEqual(first);
  expect(
    (
      await db.query<{ n: number }>(
        "select count(*)::int n from public.bids where url like 'https://example.com/capacity/%'",
      )
    ).rows[0].n,
  ).toBe(500);
});

it("imports the reviewed allowed subset while reporting fresh conflicts and preserving retry results", async () => {
  const rid = (
    await db.query<{ id: string }>("select id from public.resumes where identifier='SHEET-01'")
  ).rows[0].id;
  await asUser(client);
  await db.query("select public.update_candidate_profile_rules($1,3,2,array['BlockedCo'],'{}','{}')", [
    (await db.query<{ id: string }>("select profile_id id from public.resumes where id=$1", [rid])).rows[0].id,
  ]);
  await asUser(bidder);
  const rows = [
    { company: "Allowed reviewed", role_name: "Engineer", url: "https://example.com/reviewed/allowed", source: "", arrangement: "remote", job_status: "open" },
    { company: "BlockedCo", role_name: "Engineer", url: "https://example.com/reviewed/blocked", source: "", arrangement: "remote", job_status: "open" },
  ];
  const request = "00000000-0000-4000-8000-000000000097";
  const imported = (await db.query<{ r: { ids: string[]; sourceRows: number[]; skipped: { sourceRow: number; reasons: { code: string }[] }[] } }>(
    "select public.import_bids_reviewed($1,'2025-10-01',$2::jsonb,$3::integer[],$4) r",
    [rid, JSON.stringify(rows), [14, 19], request],
  )).rows[0].r;
  expect(imported.ids).toHaveLength(1);
  expect(imported.sourceRows).toEqual([14]);
  expect(imported.skipped).toMatchObject([{ sourceRow: 19, reasons: [{ code: "restricted_company" }] }]);
  expect((await db.query<{ n: number }>("select count(*)::int n from public.bids where url like 'https://example.com/reviewed/%'")).rows[0].n).toBe(1);
  expect((await db.query<{ r: unknown }>(
    "select public.import_bids_reviewed($1,'2025-10-01',$2::jsonb,$3::integer[],$4) r",
    [rid, JSON.stringify(rows), [14, 19], request],
  )).rows[0].r).toEqual(imported);
});

it("keeps invalid URL errors row-local in a large validation batch", async () => {
  await asUser(bidder);
  const rid = (await db.query<{ id: string }>("select id from public.resumes where identifier='SHEET-01'")).rows[0].id;
  const rows = [
    { company: "Bad", role_name: "Engineer", url: "not a URL", source: "", arrangement: "remote", job_status: "open" },
    ...Array.from({ length: 475 }, (_, index) => ({ company: `Good ${index}`, role_name: "Engineer", url: `https://example.com/large-validation/${index}`, source: "", arrangement: "remote", job_status: "open" })),
  ];
  const errors = (await db.query<{ errors: { row: number; field: string }[] }>(
    "select public.validate_bid_import($1,'2025-10-01',$2::jsonb) errors", [rid, JSON.stringify(rows)],
  )).rows[0].errors;
  expect(errors).toEqual([expect.objectContaining({ row: 1, field: "url" })]);
});

it("bulk mutations are atomic and permanent deletion is manager-only, snapshot-bound and retry-safe", async () => {
  await asUser(bidder);
  const targets = (
    await db.query<{ id: string; version: number }>(
      "select id,version from public.bids where url like 'https://example.com/capacity/%' order by id limit 2",
    )
  ).rows;
  await expect(
    db.query("select public.bulk_bid_state($1::jsonb,true)", [
      JSON.stringify([targets[0], { ...targets[1], version: -1 }]),
    ]),
  ).rejects.toThrow(/changed/i);
  expect(
    (
      await db.query<{ n: number }>(
        "select count(*)::int n from public.bids where id=$1 and deleted_at is null",
        [targets[0].id],
      )
    ).rows[0].n,
  ).toBe(1);
  await db.query("select public.bulk_bid_state($1::jsonb,true)", [
    JSON.stringify(targets),
  ]);
  const trashed = targets.map((t) => ({ ...t, version: t.version + 1 }));
  await expect(
    db.query("select public.prepare_bid_purge('selected',$1::jsonb,null)", [
      JSON.stringify(trashed),
    ]),
  ).rejects.toThrow(/manager|denied/i);
  await asUser(client);
  const op = (
    await db.query<{ r: { id: string; count: number } }>(
      "select public.prepare_bid_purge('selected',$1::jsonb,null) r",
      [JSON.stringify(trashed)],
    )
  ).rows[0].r;
  expect(op.count).toBe(2);
  await asUser(other);
  await expect(
    db.query("select public.confirm_bid_purge($1)", [op.id]),
  ).rejects.toThrow(/denied/i);
  await asUser(client);
  const deleted = (
    await db.query<{ r: { deletedCount: number } }>(
      "select public.confirm_bid_purge($1) r",
      [op.id],
    )
  ).rows[0].r;
  expect(deleted.deletedCount).toBe(2);
  expect(
    (
      await db.query<{ r: unknown }>("select public.confirm_bid_purge($1) r", [
        op.id,
      ])
    ).rows[0].r,
  ).toEqual(deleted);
  expect(
    (
      await db.query("select id from public.bids where id=any($1::uuid[])", [
        targets.map((t) => t.id),
      ])
    ).rows,
  ).toHaveLength(0);
  await asUser(bidder);
  const receipt = (
    await db.query<{ result: { ids: string[] }; payload_hash: string }>(
      "select * from public.bid_import_receipts where request_id=$1",
      ["00000000-0000-4000-8000-000000000096"],
    )
  ).rows[0];
  expect(receipt.payload_hash).toHaveLength(64);
  const rid = (
    await db.query<{ id: string }>(
      "select id from public.resumes where identifier='SHEET-01'",
    )
  ).rows[0].id;
  const rows = Array.from({ length: 500 }, (_, i) => ({
    company: `Capacity ${i}`,
    role_name: "Engineer",
    url: `https://example.com/capacity/${i}`,
    source: "",
    arrangement: "remote",
    job_status: "open",
  }));
  const replay = (
    await db.query<{ r: { purgedCount: number } }>(
      "select public.import_bids($1,'2025-10-01',$2::jsonb,$3) r",
      [rid, JSON.stringify(rows), "00000000-0000-4000-8000-000000000096"],
    )
  ).rows[0].r;
  expect(replay.purgedCount).toBe(2);
});

it("purge rejects expired/changed snapshots, isolates scope and cleans unfinished proof in leased passes", async () => {
  await asUser(bidder);
  const make = async (suffix: string) =>
    (
      await db.query<{ id: string }>(
        "select public.save_bid(null,$1,$3,'Engineer',$2,'','remote','open') id",
        [resume, `https://example.com/purge/${suffix}`, `Purge ${suffix}`],
      )
    ).rows[0].id;
  const one = await make("one"),
    two = await make("two");
  await approveBidAsClient(one);
  await asUser(bidder);
  const proof = (
    await db.query<{ id: string }>(
      "select public.prepare_file('screenshot',$1,'unfinished.png','image/png',100) id",
      [one],
    )
  ).rows[0].id;
  await db.query("select public.trash_bid($1,true)", [one]);
  await asUser(client);
  const prepare = async () =>
    (
      await db.query<{ r: { id: string; count: number } }>(
        "select public.prepare_bid_purge('selected',(select jsonb_agg(jsonb_build_object('id',id,'version',version)) from public.bids where id=$1),$2) r",
        [one, bidder],
      )
    ).rows[0].r;
  const stale = await prepare();
  await db.query("select public.trash_bid($1,false)", [one]);
  await expect(
    db.query("select public.confirm_bid_purge($1)", [stale.id]),
  ).rejects.toThrow(/changed/i);
  await db.query("select public.trash_bid($1,true)", [one]);
  const expired = await prepare();
  await db.exec("reset role");
  await db.query(
    "update public.bid_purge_operations set expires_at=now()-interval '1 second' where id=$1",
    [expired.id],
  );
  await asUser(client);
  await expect(
    db.query("select public.confirm_bid_purge($1)", [expired.id]),
  ).rejects.toThrow(/expired/i);
  const op = await prepare();
  await db.query("select public.trash_bid($1,true)", [two]);
  await db.query("select public.confirm_bid_purge($1)", [op.id]);
  expect(
    (await db.query("select id from public.bids where id=$1", [two])).rows,
  ).toHaveLength(1);
  expect(
    (await db.query("select id from public.files where id=$1", [proof])).rows,
  ).toHaveLength(0);
  expect(
    (await db.query("select id from public.bid_events where bid_id=$1", [one]))
      .rows,
  ).toHaveLength(0);
  expect(
    (await db.query("select id from public.resumes where id=$1", [resume]))
      .rows,
  ).toHaveLength(1);
  await expect(
    db.query("select * from public.storage_cleanup_tasks"),
  ).rejects.toThrow(/permission/i);
  await expect(
    db.query("select public.claim_storage_cleanup(null,50)"),
  ).rejects.toThrow(/permission/i);
  await asUser(other);
  await expect(
    db.query("select public.retry_bid_cleanup($1)", [op.id]),
  ).rejects.toThrow(/denied/i);
  await asUser(client);
  const status = async () =>
    (
      await db.query<{
        r: {
          pendingFiles: number;
          verifyingFiles: number;
          failedFiles: number;
        };
      }>("select public.bid_purge_status($1) r", [op.id])
    ).rows[0].r;
  expect((await status()).pendingFiles).toBe(1);
  await db.exec("reset role;set role service_role");
  const claim = async () =>
    (
      await db.query<{ id: string; lease_id: string }>(
        "select * from public.claim_storage_cleanup($1,50)",
        [op.id],
      )
    ).rows;
  const task = (await claim())[0];
  expect(await claim()).toHaveLength(0);
  await db.query("select public.finish_storage_cleanup($1,$2,false)", [
    task.id,
    task.lease_id,
  ]);
  await asUser(client);
  expect((await status()).failedFiles).toBe(1);
  await db.query("select public.retry_bid_cleanup($1)", [op.id]);
  await db.exec("reset role;set role service_role");
  const retry = (await claim())[0];
  await db.query("select public.finish_storage_cleanup($1,$2,true)", [
    retry.id,
    retry.lease_id,
  ]);
  expect(await claim()).toHaveLength(0);
  await asUser(client);
  expect((await status()).verifyingFiles).toBe(1);
  await db.query("select public.retry_bid_cleanup($1)", [op.id]);
  await db.exec("reset role;set role service_role");
  expect(await claim()).toHaveLength(0);
  await db.query(
    "update public.storage_cleanup_tasks set next_attempt_at=now()-interval '1 second' where id=$1",
    [task.id],
  );
  const final = (await claim())[0];
  await db.query("select public.finish_storage_cleanup($1,$2,true)", [
    final.id,
    final.lease_id,
  ]);
  expect(
    (
      await db.query<{ storage_path: string | null }>(
        "select storage_path from public.storage_cleanup_tasks where id=$1",
        [task.id],
      )
    ).rows[0].storage_path,
  ).toBeNull();
  await asUser(client);
  expect((await status()).pendingFiles).toBe(0);
  await asUser(bidder);
  await expect(make("one")).resolves.toBeTruthy();
});

it("keeps older unfinished cleanup discoverable after newer completed purges", async () => {
  await db.exec("reset role");
  const old = (
    await db.query<{ id: string }>(
      "insert into public.bid_purge_operations(actor_id,scope,targets,count,completed_at) values($1,'Selected trashed bids','[]',1,now()-interval '1 day') returning id",
      [client],
    )
  ).rows[0].id;
  await db.query(
    "insert into public.storage_cleanup_tasks(operation_id,storage_path,last_error) values($1,'synthetic/pending','retry pending')",
    [old],
  );
  await db.query(
    "insert into public.bid_purge_operations(actor_id,scope,targets,count,completed_at) select $1,'Selected trashed bids','[]',1,now() from generate_series(1,11)",
    [client],
  );
  await asUser(client);
  const status = (
    await db.query<{ r: { id: string }[] }>(
      "select public.recent_bid_purges() r",
    )
  ).rows[0].r;
  expect(status.map((o) => o.id)).toContain(old);
});

const taskOperation = async (count = 1, completed = true) =>
  (
    await db.query<{ id: string }>(
      `insert into public.bid_purge_operations(actor_id,scope,targets,count,completed_at) values($1,'Selected trashed bids','[]',$2,${completed ? "now()" : "null"}) returning id`,
      [client, count],
    )
  ).rows[0].id;

it("reports phase counts, server time and the next eligible attempt", async () => {
  await db.exec("reset role");
  const op = await taskOperation(3);
  await db.query(
    `insert into public.storage_cleanup_tasks(operation_id,storage_path,first_removed_at,next_attempt_at) values
     ($1,'s/verify-waiting',now(),now()+interval '4 minutes'),
     ($1,'s/removing',null,now()),
     ($1,'s/leased',now(),now()-interval '1 minute')`,
    [op],
  );
  await db.query(
    "update public.storage_cleanup_tasks set lease_id=gen_random_uuid(),lease_until=now()+interval '2 minutes' where storage_path='s/leased'",
  );
  await asUser(client);
  const s = (
    await db.query<{ r: Record<string, number | string | null> }>(
      "select public.bid_purge_status($1) r",
      [op],
    )
  ).rows[0].r;
  expect(s).toMatchObject({
    pendingFiles: 3,
    awaitingRemovalFiles: 1,
    verifyingFiles: 2,
    processingFiles: 1,
    failedFiles: 0,
    deletedCount: 3,
  });
  expect(Date.parse(String(s.serverTime))).not.toBeNaN();
  // The leased task is excluded, so the earliest idle attempt is the immediate removal.
  expect(Date.parse(String(s.nextAttemptAt))).toBeLessThanOrEqual(
    Date.parse(String(s.serverTime)),
  );
  await db.exec("reset role");
  await db.query(
    "update public.storage_cleanup_tasks set completed_at=now() where operation_id=$1 and storage_path<>'s/verify-waiting'",
    [op],
  );
  await asUser(client);
  const waiting = (
    await db.query<{ r: { nextAttemptAt: string; serverTime: string } }>(
      "select public.bid_purge_status($1) r",
      [op],
    )
  ).rows[0].r;
  expect(Date.parse(waiting.nextAttemptAt)).toBeGreaterThan(
    Date.parse(waiting.serverTime) + 3 * 60_000,
  );
});

it("retry never shortens an in-flight verification delay or a live lease", async () => {
  await db.exec("reset role");
  const op = await taskOperation(2);
  await db.query(
    `insert into public.storage_cleanup_tasks(operation_id,storage_path,first_removed_at,next_attempt_at,last_error,lease_id,lease_until) values
     ($1,'s/leased-failed',now(),now()+interval '1 minute','retry pending',gen_random_uuid(),now()+interval '2 minutes'),
     ($1,'s/failed',null,now()+interval '1 minute','retry pending',null,null),
     ($1,'s/verify-waiting',now(),now()+interval '4 minutes',null,null,null)`,
    [op],
  );
  await asUser(client);
  const r = (
    await db.query<{ r: { failedFiles: number; processingFiles: number } }>(
      "select public.retry_bid_cleanup($1) r",
      [op],
    )
  ).rows[0].r;
  expect(r).toMatchObject({ failedFiles: 1, processingFiles: 1 });
  await db.exec("reset role");
  const due = Object.fromEntries(
    (
      await db.query<{ storage_path: string; due: boolean }>(
        "select storage_path,next_attempt_at<=clock_timestamp() due from public.storage_cleanup_tasks where operation_id=$1",
        [op],
      )
    ).rows.map((x) => [x.storage_path, x.due]),
  );
  expect(due).toEqual({
    "s/failed": true,
    "s/leased-failed": false,
    "s/verify-waiting": false,
  });
});

it("scheduler probe is true only for due, unleased work and is service-only", async () => {
  await db.exec("reset role");
  await db.exec("delete from public.storage_cleanup_tasks");
  const probe = async () =>
    (
      await db.query<{ r: boolean }>(
        "select public.has_due_storage_cleanup() r",
      )
    ).rows[0].r;
  expect(await probe()).toBe(false);
  const op = await taskOperation();
  const task = (
    await db.query<{ id: string }>(
      "insert into public.storage_cleanup_tasks(operation_id,storage_path,first_removed_at,next_attempt_at) values($1,'s/x',now(),now()+interval '5 minutes') returning id",
      [op],
    )
  ).rows[0].id;
  expect(await probe()).toBe(false);
  await db.query(
    "update public.storage_cleanup_tasks set next_attempt_at=now()-interval '1 second' where id=$1",
    [task],
  );
  expect(await probe()).toBe(true);
  await db.query(
    "update public.storage_cleanup_tasks set lease_id=gen_random_uuid(),lease_until=now()+interval '2 minutes' where id=$1",
    [task],
  );
  expect(await probe()).toBe(false);
  await db.query(
    "update public.storage_cleanup_tasks set lease_until=now()-interval '1 second' where id=$1",
    [task],
  );
  expect(await probe()).toBe(true);
  await asUser(client);
  await expect(
    db.query("select public.has_due_storage_cleanup()"),
  ).rejects.toThrow(/permission/i);
});

it("scheduler function calls the endpoint only when work is due, with auth headers", async () => {
  await db.exec("reset role");
  await db.exec(`create schema if not exists net; create schema if not exists vault;
   create table if not exists public.http_calls(url text, headers jsonb, timeout integer);
   create or replace function net.http_get(url text, headers jsonb, timeout_milliseconds integer) returns bigint language sql as $$ insert into public.http_calls values(url,headers,timeout_milliseconds) returning 1::bigint $$;
   create table if not exists vault.decrypted_secrets(name text, decrypted_secret text);
   delete from vault.decrypted_secrets; delete from public.http_calls; delete from public.storage_cleanup_tasks;`);
  await db.exec(
    readFileSync("supabase/scheduler/storage-cleanup-function.sql", "utf8"),
  );
  const invoke = () => db.query("select public.invoke_storage_cleanup()");
  await invoke();
  expect((await db.query("select * from public.http_calls")).rows).toHaveLength(
    0,
  );
  const op = await taskOperation();
  await db.query(
    "insert into public.storage_cleanup_tasks(operation_id,storage_path) values($1,'s/y')",
    [op],
  );
  await expect(invoke()).rejects.toThrow(/not configured/i);
  await db.exec(`insert into vault.decrypted_secrets values
   ('storage_cleanup_url','https://example.test/api/cron/storage-cleanup'),('storage_cleanup_secret','s3cret'),('storage_cleanup_bypass','bypass')`);
  await invoke();
  const calls = (
    await db.query<{
      url: string;
      headers: Record<string, string>;
      timeout: number;
    }>("select * from public.http_calls")
  ).rows;
  expect(calls).toHaveLength(1);
  expect(calls[0].headers).toEqual({
    authorization: "Bearer s3cret",
    "x-vercel-protection-bypass": "bypass",
  });
  expect(calls[0].timeout).toBe(55000);
  await asUser(client);
  await expect(
    db.query("select public.invoke_storage_cleanup()"),
  ).rejects.toThrow(/permission/i);
});

it("lets a second worker reclaim a task only after the first worker's lease expires", async () => {
  await db.exec("reset role");
  await db.exec("delete from public.storage_cleanup_tasks");
  const op = await taskOperation();
  await db.query(
    "insert into public.storage_cleanup_tasks(operation_id,storage_path) values($1,'s/z')",
    [op],
  );
  await db.exec("set role service_role");
  const claim = async () =>
    (
      await db.query<{ id: string; lease_id: string }>(
        "select * from public.claim_storage_cleanup(null,50)",
      )
    ).rows;
  const first = (await claim())[0];
  expect(await claim()).toHaveLength(0);
  await db.exec("reset role");
  await db.query(
    "update public.storage_cleanup_tasks set lease_until=now()-interval '1 second' where id=$1",
    [first.id],
  );
  await db.exec("set role service_role");
  const second = (await claim())[0];
  expect(second.lease_id).not.toBe(first.lease_id);
  // The stale worker can no longer record a result for the reclaimed task.
  await db.query("select public.finish_storage_cleanup($1,$2,true)", [
    first.id,
    first.lease_id,
  ]);
  await db.exec("reset role");
  expect(
    (
      await db.query<{ first_removed_at: string | null }>(
        "select first_removed_at from public.storage_cleanup_tasks where id=$1",
        [first.id],
      )
    ).rows[0].first_removed_at,
  ).toBeNull();
});

it("shares candidate profile details but keeps each bidder assignment private", async () => {
  await asUser(client);
  const profile = (
    await db.query<{ id: string }>(
      "select public.save_candidate_profile(null,$1,'SHARED-01','Shared Candidate','Chicago, IL','https://portfolio.test','Use the shared experience') id",
      [workspace],
    )
  ).rows[0].id;
  const firstAssignment = (
    await db.query<{ id: string }>(
      "select public.save_resume_assignment(null,$1,$2,'first@test.com','555-0101',null,100) id",
      [profile, bidder],
    )
  ).rows[0].id;
  const peer = "00000000-0000-4000-8000-000000000004";
  const secondAssignment = (
    await db.query<{ id: string }>(
      "select public.save_resume_assignment(null,$1,$2,'second@test.com','555-0102',null,200) id",
      [profile, peer],
    )
  ).rows[0].id;
  await finalizeResumeFile(firstAssignment);
  await finalizeResumeFile(secondAssignment);

  await asUser(client);
  const unrelatedProfile = (
    await db.query<{ id: string }>(
      "select public.save_candidate_profile(null,$1,'SHARED-02','Other Candidate','','','') id",
      [workspace],
    )
  ).rows[0].id;
  const unrelatedAssignment = (
    await db.query<{ id: string }>(
      "select public.save_resume_assignment(null,$1,$2,'other@test.com','555-0103',null,null) id",
      [unrelatedProfile, bidder],
    )
  ).rows[0].id;
  const unrelatedPdf = await finalizeResumeFile(unrelatedAssignment);
  await asUser(client);
  await expect(
    db.query(
      "select public.save_resume_assignment($1,$2,$3,'first@test.com','555-0101',$4,100)",
      [firstAssignment, profile, bidder, unrelatedPdf],
    ),
  ).rejects.toThrow(/PDF|verified/i);
  await db.query(
    "select public.save_resume_assignment($1,$2,$3,'other-owner@test.com','555-0104',null,null)",
    [unrelatedAssignment, unrelatedProfile, peer],
  );
  const moved = (
    await db.query<{ bidder_id: string; file_id: string | null }>(
      "select bidder_id,file_id from public.resumes where id=$1",
      [unrelatedAssignment],
    )
  ).rows[0];
  expect(moved.bidder_id).toBe(peer);
  expect(moved.file_id).toBeNull();

  await asUser(bidder);
  await db.query(
    "select public.save_bid(null,$1,'Shared Co','Engineer','https://shared.test/job/1','LinkedIn','remote','open')",
    [firstAssignment],
  );
  expect(
    (
      await db.query("select id from public.candidate_profiles where id=$1", [
        profile,
      ])
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await db.query("select id from public.resumes where id=$1", [
        firstAssignment,
      ])
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await db.query("select id from public.resumes where id=$1", [
        secondAssignment,
      ])
    ).rows,
  ).toHaveLength(0);
  await asUser(peer);
  await expect(
    db.query(
      "select public.save_bid(null,$1,' shared   co ','engineer','https://shared.test/job/2','LinkedIn','remote','open')",
      [secondAssignment],
    ),
  ).rejects.toMatchObject({ message: "Blocked", code: "PBC01" });
});

it("aggregates CT reporting before retention and queues screenshot cleanup", async () => {
  await asUser(client);
  const profileId = (
    await db.query<{ id: string }>(
      "select public.save_candidate_profile(null,$1,'RET-01','Retention Candidate','','','') id",
      [workspace],
    )
  ).rows[0].id;
  const assignmentId = (
    await db.query<{ id: string }>(
      "select public.save_resume_assignment(null,$1,$2,'retention@test.com','555-0199',null,250) id",
      [profileId, bidder],
    )
  ).rows[0].id;
  await finalizeResumeFile(assignmentId);
  await asUser(bidder);
  const retentionBid = (
    await db.query<{ id: string }>(
      "select public.save_bid(null,$1,'Retention Co','Engineer','https://retention.test/old','LinkedIn','remote','open') id",
      [assignmentId],
    )
  ).rows[0].id;
  await approveBidAsClient(retentionBid);
  await asUser(bidder);
  const proof = (
    await db.query<{ id: string }>(
      "select public.prepare_file('screenshot',$1,'proof.png','image/png',100) id",
      [retentionBid],
    )
  ).rows[0].id;
  await db.exec("reset role; set role service_role; select set_config('request.jwt.claim.role','service_role',false)");
  await db.query("select public.finalize_verified_file($1,$2,$3)", [proof, "e".repeat(64), bidder]);
  await db.exec("reset role");
  await db.query(
    "update public.bids set found_at=clock_timestamp()-interval '5 months', applied_at=clock_timestamp()-interval '4 months', first_applied_at=clock_timestamp()-interval '4 months' where id=$1",
    [retentionBid],
  );
  await asUser(client);
  const preview = (
    await db.query<{ result: { eligible: number } }>(
      "select public.candidate_retention_preview($1,1) result",
      [profileId],
    )
  ).rows[0].result;
  expect(preview.eligible).toBe(1);
  await expect(
    db.query("select public.update_candidate_profile_rules($1,3,1,'{}','{}','{}')", [profileId]),
  ).rejects.toThrow(/affects 1 applied bids/i);
  await db.query(
    "select public.update_candidate_profile_rules($1,3,1,'{}','{}','{}',1)",
    [profileId],
  );
  await db.query("select public.set_bid_interview($1,true,clock_timestamp(),'Interview details','')", [retentionBid]);
  await db.exec("set role service_role; select set_config('request.jwt.claim.role','service_role',false)");
  const result = (
    await db.query<{ result: { deletedApplications: number; storageTasksQueued: number } }>(
      "select public.process_candidate_retention(10) result",
    )
  ).rows[0].result;
  expect(result).toEqual({ deletedApplications: 1, storageTasksQueued: 1, limit: 10 });
  await db.exec("reset role");
  expect((await db.query("select id from public.bids where id=$1", [retentionBid])).rows).toHaveLength(0);
  const history = (
    await db.query<{ metric: string; record_count: number; earned_cents: number; interview_count: number; tracked_count: number }>(
      "select metric,record_count,earned_cents,interview_count,tracked_count from public.retained_bid_daily_aggregates where profile_id=$1 order by metric",
      [profileId],
    )
  ).rows;
  expect(history.map((row) => row.metric)).toEqual(["applied_activity", "earning", "found"]);
  expect(history.find((row) => row.metric === "earning")?.earned_cents).toBe(250);
  expect(history.find((row) => row.metric === "earning")?.interview_count).toBe(1);
  expect(history.find((row) => row.metric === "earning")?.tracked_count).toBe(1);
  expect((await db.query("select id from public.files where id=$1", [proof])).rows).toHaveLength(0);
  expect((await db.query("select id from public.files where resume_id=$1", [assignmentId])).rows).toHaveLength(1);
  expect((await db.query("select id from public.storage_cleanup_tasks where operation_id is null and storage_path like $1", [`%/${proof}`])).rows).toHaveLength(1);
});
it("subtracts retention as CT calendar months across month-end and daylight saving", async () => {
  const monthEnd = (
    await db.query<{ cutoff: Date }>(
      "select public.candidate_retention_cutoff('2026-05-31 17:00:00+00',3) cutoff",
    )
  ).rows[0].cutoff;
  expect(new Date(monthEnd).toISOString()).toBe("2026-02-28T18:00:00.000Z");
  const dst = (
    await db.query<{ cutoff: Date }>(
      "select public.candidate_retention_cutoff('2026-03-15 08:30:00+00',1) cutoff",
    )
  ).rows[0].cutoff;
  expect(new Date(dst).toISOString()).toBe("2026-02-15T09:30:00.000Z");
});

it("blocks bidder screenshot uploads until client approval and lets only managers record interviews", async () => {
  await asUser(bidder);
  const newBidId = (
    await db.query<{ id: string }>(
      "select public.save_bid(null,$1,'Review Co','Data Analyst','https://example.com/review-job','Direct','remote','open') id",
      [resume],
    )
  ).rows[0].id;
  const newBid = (
    await db.query<{ id: string; version: number; review_status: string }>(
      "select id,version,review_status from public.bids where id=$1",
      [newBidId],
    )
  ).rows[0];
  expect(newBid.review_status).toBe("pending");
  await expect(
    db.query("select public.prepare_file('screenshot',$1,'review.png','image/png',100)", [newBid.id]),
  ).rejects.toThrow(/approval/i);

  await asUser(client);
  await db.query("select public.review_bid($1,'approved',null,$2)", [newBid.id, newBid.version]);
  await asUser(bidder);
  const upload = (
    await db.query<{ id: string }>(
      "select public.prepare_file('screenshot',$1,'review.png','image/png',100) id",
      [newBid.id],
    )
  ).rows[0].id;
  await db.exec("reset role; set role service_role; select set_config('request.jwt.claim.role','service_role',false)");
  await db.query("select public.finalize_verified_file($1,$2,$3)", [upload, "c".repeat(64), bidder]);
  await asUser(bidder);
  await expect(
    db.query("select public.set_bid_interview($1,true,null,'Private note',null)", [newBid.id]),
  ).rejects.toThrow(/access denied/i);
  await asUser(client);
  await db.query("select public.set_bid_interview($1,true,'2026-10-06T15:00:00Z','Panel interview',null)", [newBid.id]);
  await asUser(bidder);
  const result = (
    await db.query<{ interview_scheduled: boolean; interview_notes: string }>(
      "select interview_scheduled,interview_notes from public.bids where id=$1",
      [newBid.id],
    )
  ).rows[0];
  expect(result).toEqual({ interview_scheduled: true, interview_notes: "Panel interview" });
});
it("manager-created bids are approved and identity edits invalidate prepared proof", async () => {
  await asUser(client);
  const created = (
    await db.query<{ id: string }>(
      "select public.save_bid(null,$1,'Client Review Co','Programmer','https://example.com/client-review','Direct','onsite','open') id",
      [resume],
    )
  ).rows[0].id;
  const state = (
    await db.query<{ version: number; review_status: string; review_revision: number }>(
      "select version,review_status,review_revision from public.bids where id=$1",
      [created],
    )
  ).rows[0];
  expect(state.review_status).toBe("approved");
  await asUser(bidder);
  const proof = (
    await db.query<{ id: string }>(
      "select public.prepare_file('screenshot',$1,'stale.png','image/png',100) id",
      [created],
    )
  ).rows[0].id;
  await db.query("select public.update_bid_cell($1,'company','Updated Co',$2)", [created, state.version]);
  expect(
    (
      await db.query<{ review_status: string; review_revision: number }>(
        "select review_status,review_revision from public.bids where id=$1",
        [created],
      )
    ).rows[0],
  ).toEqual({ review_status: "pending", review_revision: state.review_revision + 1 });
  await db.exec("reset role; set role service_role; select set_config('request.jwt.claim.role','service_role',false)");
  await expect(
    db.query("select public.finalize_verified_file($1,$2,$3)", [proof, "d".repeat(64), bidder]),
  ).rejects.toThrow(/approval changed/i);
});

it("managers can atomically apply selected bids without proof at a chosen time", async () => {
  const request = "00000000-0000-4000-8000-000000000090";
  await asUser(client);
  await db.query("select public.update_bidder($1,'Jordan',125,false)", [bidder]);
  const target = (await db.query<{ id: string }>("select public.save_bid(null,$1,'Manual Test Co','Analyst','https://example.com/jobs/manual-test','LinkedIn','remote','open') id", [resume])).rows[0].id;
  const configured = (await db.query<{ values: { bidders: Record<string, number | null>; resumes: Record<string, number | null> } }>("select public.manager_financial_values(array[$1]::uuid[],array[$2]::uuid[]) values", [bidder,resume])).rows[0].values;
  const expectedRate = configured.resumes[resume] ?? configured.bidders[bidder];
  const targetVersion = (await db.query<{ version: number }>("select version from public.bids where id=$1", [target])).rows[0].version;
  expect((await db.query<{ applied: boolean; review_status: string }>("select applied,review_status from public.bids where id=$1", [target])).rows[0]).toMatchObject({ applied: false, review_status: "approved" });
  const appliedAt = (await db.query<{ stamp: string }>("select clock_timestamp() stamp")).rows[0].stamp;
  const result = await db.query<{ result: { applied: number; unchanged: number } }>(
    "select public.manual_apply_bids($1::jsonb,$2::timestamptz,$3,$4) result",
    [[{ id: target, version: targetVersion }], appliedAt, "Verified with employer", request],
  );
  expect(result.rows[0].result).toMatchObject({ applied: 1, unchanged: 0 });
  const saved = (await db.query<{ applied: boolean; evidence_file_id: string | null; applied_at: string; first_applied_at: string; application_method: string; review_status: string }>(
    "select applied,evidence_file_id,applied_at,first_applied_at,application_method,review_status from public.bids where id=$1", [target],
  )).rows[0];
  expect(saved).toMatchObject({ applied: true, evidence_file_id: null, application_method: "manual", review_status: "approved", applied_at: appliedAt, first_applied_at: appliedAt });
  expect(await managerBidRate(target, client)).toBe(expectedRate);
  const reportDay = formatInTimeZone(new Date(appliedAt), "America/Chicago", "yyyy-MM-dd");
  const report = (await db.query<{ result: { totals: { count: number }; groups: { label: string; applied: number }[] } }>(
    "select public.earnings_performance($1,$1,$2,null,null,'profile') result", [reportDay, workspace],
  )).rows[0].result;
  expect(report.totals.count).toBeGreaterThanOrEqual(1);
  expect(report.groups.some((row) => row.applied >= 1)).toBe(true);
  await db.query("select public.set_applied($1,false,null,'Corrected manual application record')", [target]);
  expect((await db.query<{ applied: boolean; evidence_file_id: string | null }>("select applied,evidence_file_id from public.bids where id=$1", [target])).rows[0]).toMatchObject({ applied: false, evidence_file_id: null });
  expect((await db.query<{ result: { applied: number; unchanged: number } }>("select public.manual_apply_bids($1::jsonb,$2::timestamptz,$3,$4) result", [[{ id: target, version: targetVersion }], appliedAt, "Verified with employer", request])).rows[0].result).toEqual({ applied: 1, unchanged: 0 });
  expect((await db.query<{ applied: boolean }>("select applied from public.bids where id=$1", [target])).rows[0].applied).toBe(false);
  expect((await db.query<{ applied_at: string }>("select applied_at from public.bids where id=$1", [target])).rows[0].applied_at).toEqual(appliedAt);
});

it("manual application rejects bidders and rolls back an invalid batch", async () => {
  const request = "00000000-0000-4000-8000-000000000091";
  const before = (await db.query<{ version: number; applied: boolean }>("select version,applied from public.bids where id=$1", [bid])).rows[0];
  await asUser(bidder);
  await expect(db.query("select public.manual_apply_bids($1::jsonb,$2::timestamptz,$3,$4)", [[{ id: bid, version: before.version }], "2026-10-05T18:30:00Z", "Manual", request])).rejects.toThrow();
  await asUser(client);
  const first = (await db.query<{ id: string }>("select public.save_bid(null,$1,'Other Co','Developer','https://example.com/jobs/manual-rate-a','LinkedIn','remote','open') id", [resume])).rows[0].id;
  const second = (await db.query<{ id: string }>("select public.save_bid(null,$1,'Third Co','Developer','https://example.com/jobs/manual-rate-b','LinkedIn','remote','open') id", [resume])).rows[0].id;
  await db.exec("reset role");
  await db.query("update public.bidders set default_rate_cents=null where user_id=$1", [bidder]);
  const firstVersion = (await db.query<{ version: number }>("select version from public.bids where id=$1", [first])).rows[0].version;
  const secondVersion = (await db.query<{ version: number }>("select version from public.bids where id=$1", [second])).rows[0].version;
  await asUser(client);
  const appliedAt = (await db.query<{ stamp: string }>("select clock_timestamp() stamp")).rows[0].stamp;
  await expect(db.query("select public.manual_apply_bids($1::jsonb,$2::timestamptz,$3,$4)", [[{ id: first, version: firstVersion }, { id: second, version: secondVersion }], appliedAt, "Manual", request])).rejects.toThrow(/rate/i);
  expect((await db.query<{ applied: boolean }>("select applied from public.bids where id=$1", [first])).rows[0].applied).toBe(false);
  expect((await db.query<{ applied: boolean }>("select applied from public.bids where id=$1", [second])).rows[0].applied).toBe(false);
});

it("lists bids with database filters and applies pagination before returning rows", async () => {
  await asUser(client);
  for (let i = 0; i < 12; i++) {
    await db.query(
      "select public.save_bid(null,$1,$2,'Pager',$3,'Custom source','remote','open')",
      [resume, `Pager ${i}`, `https://pager.test/job/${i}`],
    );
  }
  const result = (await db.query<{ result: { rows: { company: string }[]; total: number } }>(
    "select public.list_bids($1::jsonb) result",
    [JSON.stringify({ trash: false, rangeFrom: null, rangeTo: null, search: "Pager", columnFilters: { source: "Custom source" }, sorting: [{ id: "company", desc: true }], pageIndex: 1, pageSize: 5 })],
  )).rows[0].result;
  expect(result.rows).toHaveLength(5);
  expect(result.total).toBe(12);
  expect(result.rows[0].company).toBe("Pager 4");
  await expect(db.query(
    "select public.list_bids($1::jsonb)",
    [JSON.stringify({ trash: false, bidder: other, pageIndex: 0, pageSize: 10 })],
  )).resolves.toBeDefined();
  await db.exec("reset role");
  await db.query("delete from public.bid_events where bid_id in (select id from public.bids where company like 'Pager %')");
  await db.query("delete from public.bids where company like 'Pager %'");
});

it("resets only an explicitly inventoried application library and preserves accounts", async () => {
  const adminId = "00000000-0000-4000-8000-000000000006";
  await db.exec("reset role");
  await db.query("insert into auth.users(id,email) values($1,'reset-admin@test.com')", [adminId]);
  await db.exec("set role service_role; select set_config('request.jwt.claim.role','service_role',false)");
  await db.query("update public.profiles set role='admin',approval_status='approved' where id=$1", [adminId]);
  const filePaths = (
    await db.query<{ storage_path: string }>(
      "select storage_path from public.files where workspace_id=$1",
      [workspace],
    )
  ).rows.map((row) => row.storage_path);
  const importRequest = "00000000-0000-4000-8000-000000000099";
  await db.query(
    "insert into public.bid_import_receipts(actor_id,request_id,payload_hash,result) values($1,$2,$3,$4::jsonb)",
    [client, importRequest, "f".repeat(64), JSON.stringify({ ids: [bid], resume, bidder })],
  );
  const purge = "00000000-0000-4000-8000-000000000098";
  await db.query(
    "insert into public.bid_purge_operations(id,actor_id,scope,bidder_id,targets,count) values($1,$2,'Selected trashed bids',$3,$4::jsonb,1)",
    [purge, client, bidder, JSON.stringify([{ id: bid, version: 1 }])],
  );
  const inventory = (
    await db.query<{ result: { fingerprint: string; bidCount: number; fileCount: number; assignmentCount: number } }>(
      "select public.application_library_inventory(array[$1::uuid]) result",
      [workspace],
    )
  ).rows[0].result;
  expect(inventory.bidCount).toBeGreaterThan(0);
  expect(inventory.assignmentCount).toBeGreaterThan(0);
  expect(inventory.fileCount).toBeGreaterThan(0);
  await db.query(
    "update public.candidate_profiles set instructions='changed after inventory' where id=(select profile_id from public.resumes where id=$1)",
    [resume],
  );
  await expect(
    db.query("select public.reset_application_library(array[$1::uuid],$2,$3)", [workspace, inventory.fingerprint, adminId]),
  ).rejects.toThrow(/changed after inventory/i);
  const confirmedInventory = (
    await db.query<{ result: { fingerprint: string } }>(
      "select public.application_library_inventory(array[$1::uuid]) result",
      [workspace],
    )
  ).rows[0].result;
  await db.query("select public.set_application_library_cutover(true)");
  await asUser(bidder);
  const gateBid = (
    await db.query<{ version: number }>("select version from public.bids where id=$1", [bid])
  ).rows[0];
  await expect(
    db.query("select public.update_bid_cell($1,'source','paused-check',$2)", [bid, gateBid.version]),
  ).rejects.toThrow(/temporarily paused/i);
  await db.exec("reset role; set role service_role; select set_config('request.jwt.claim.role','service_role',false)");
  const reset = (
    await db.query<{ result: { deleted: boolean; storageTasksQueued: number } }>(
      "select public.reset_application_library(array[$1::uuid],$2,$3) result",
      [workspace, confirmedInventory.fingerprint, adminId],
    )
  ).rows[0].result;
  expect(reset.deleted).toBe(true);
  expect(reset.storageTasksQueued).toBeGreaterThan(0);
  expect((await db.query("select id from public.workspaces where id=$1", [workspace])).rows).toHaveLength(1);
  expect((await db.query("select user_id from public.bidders where user_id=$1", [bidder])).rows).toHaveLength(1);
  expect((await db.query("select id from public.profiles where id in ($1,$2,$3)", [client, bidder, adminId])).rows).toHaveLength(3);
  for (const table of ["candidate_profiles", "resumes", "bids", "files", "retained_bid_daily_aggregates"]) {
    expect((await db.query(`select 1 from public.${table} where workspace_id=$1 limit 1`, [workspace])).rows).toHaveLength(0);
  }
  expect((await db.query("select 1 from public.bid_events limit 1")).rows).toHaveLength(0);
  for (const path of filePaths) {
    expect(
      (await db.query("select id from public.storage_cleanup_tasks where storage_path=$1", [path])).rows,
    ).not.toHaveLength(0);
  }
  const receipt = (
    await db.query<{ payload_hash: string; result: { ids: unknown[]; reset: boolean } }>(
      "select payload_hash,result from public.bid_import_receipts where actor_id=$1 and request_id=$2",
      [client, importRequest],
    )
  ).rows[0];
  expect(receipt.payload_hash).toBe("f".repeat(64));
  expect(receipt.result).toEqual({ ids: [], reset: true });
  expect(
    (
      await db.query<{ targets: unknown[]; bidder_id: string | null; count: number }>(
        "select targets,bidder_id,count from public.bid_purge_operations where id=$1",
        [purge],
      )
    ).rows[0],
  ).toEqual({ targets: [], bidder_id: null, count: 1 });
  const audit = (
    await db.query<{ bid_count: number; file_count: number }>(
      "select bid_count,file_count from public.application_library_reset_audits where actor_id=$1",
      [adminId],
    )
  ).rows[0];
  expect(audit.bid_count).toBe(inventory.bidCount);
  expect(audit.file_count).toBe(inventory.fileCount);
  await db.query("select public.set_application_library_cutover(false)");
});

it("preserves public signup, managed provisioning, approval and two month retention after notification retirement", async () => {
  const admin = other;
  const publicClient = "00000000-0000-4000-8000-000000000011";
  await db.exec("reset role");
  await db.query("update public.profiles set role='admin', archived=false where id=$1", [admin]);
  await db.query(
    "insert into auth.users(id,email,raw_user_meta_data) values($1,'pending@example.test',jsonb_build_object('display_name','Pending Client'))",
    [publicClient],
  );
  const pending = (
    await db.query<{ approval_status: string }>(
      "select approval_status from public.profiles where id=$1",
      [publicClient],
    )
  ).rows[0];
  expect(pending.approval_status).toBe("pending");
  const newProfile = (
    await db.query<{ retention_months: number }>(
      "insert into public.candidate_profiles(workspace_id,identifier,candidate_name) values($1,'TWO-MONTH','Default check') returning retention_months",
      [workspace],
    )
  ).rows[0];
  expect(newProfile.retention_months).toBe(2);
  await asUser(admin);
  const managedClient = (await db.query<{ reserve_client_account: string }>(
    "select public.reserve_client_account('managed@example.test','Managed Client')",
  )).rows[0].reserve_client_account;
  await db.exec("reset role");
  await expect(db.query(
    "insert into auth.users(id,email,raw_user_meta_data) values('00000000-0000-4000-8000-000000000013','managed@example.test','{}')",
  )).rejects.toThrow("reserved for a managed account");
  await db.query(
    "insert into auth.users(id,email,raw_user_meta_data) values($1,'managed@example.test',jsonb_build_object('display_name','Managed Client'))",
    [managedClient],
  );
  expect(
    (
      await db.query<{ approval_status: string }>(
        "select approval_status from public.profiles where id=$1",
        [managedClient],
      )
  ).rows[0].approval_status,
  ).toBe("approved");
  await asUser(admin);
  await db.query("select public.review_client($1,'approved',null)", [publicClient]);
  await db.exec("reset role");
  expect((await db.query("select approval_status from public.profiles where id=$1", [publicClient])).rows).toEqual([{ approval_status: 'approved' }]);
  expect((await db.query("select to_regclass('public.inbox_notifications') retired")).rows).toEqual([{ retired: null }]);
});

it("returns a bounded, tenant-scoped legacy manager dashboard report with a complete daily series", async () => {
  await asUser(client);
  const result = await db.query<{ report: {
    daily: { date: string; found: number; foundApplied: number; applied: number }[];
    totals: { found: number; foundApplied: number };
    groups: unknown[];
  } }>(
    "select public.dashboard_performance('2026-01-01','2026-01-03',null,null,null,'profile') report",
  );
  expect(result.rows[0].report.daily.map((day) => day.date)).toEqual([
    "2026-01-01", "2026-01-02", "2026-01-03",
  ]);
  expect(result.rows[0].report.totals.found).toBeGreaterThanOrEqual(0);
  await expect(db.query(
    "select public.dashboard_performance('2026-01-01','2026-01-03',null,$1,null,'profile')",
    [other],
  )).rejects.toThrow("Access denied");
  await expect(db.query(
    "select public.dashboard_performance('2025-01-01','2026-01-03',null,null,null,'profile')",
  )).rejects.toThrow("Choose a reporting range");
});
