import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
let db: PGlite;
const owner = "10000000-0000-4000-8000-000000000001",
  bidder = "10000000-0000-4000-8000-000000000002";
let w: string, p: string, r: string;
async function asUser() {
  await db.exec(
    `reset role; set role authenticated; select set_config('request.jwt.claim.sub','${owner}',false); select set_config('request.jwt.claim.role','authenticated',false)`,
  );
}
async function cleanup(limit = 10) {
  await db.exec(
    "reset role; set role service_role; select set_config('request.jwt.claim.role','service_role',false)",
  );
  const result = (
    await db.query<{
      result: {
        deletedApplications: number;
        storageTasksQueued: number;
        limit: number;
      };
    }>("select public.process_candidate_retention($1) result", [limit])
  ).rows[0].result;
  await db.exec("reset role");
  return result;
}
async function report() {
  await asUser();
  return (
    await db.query<{
      report: {
        totals: Record<string, number>;
        financial: unknown;
        comparisons: { profiles: unknown[]; bidders: unknown[] };
      };
    }>(
      "select public.dashboard_performance_v2(null,null,null,null,null) report",
    )
  ).rows[0].report;
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

  const migration = "202610120006_arrangement_reporting.sql";
  for (const f of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql") && f < migration)
    .sort())
    await db.exec(readFileSync(`supabase/migrations/${f}`, "utf8"));
  await db.query(
    "insert into auth.users(id,email) values($1,'owner@retention.test'),($2,'bidder@retention.test')",
    [owner, bidder],
  );
  await db.exec("update public.profiles set approval_status='approved'");
  w = (
    await db.query<{ id: string }>(
      "select id from public.workspaces where owner_id=$1",
      [owner],
    )
  ).rows[0].id;
  await db.query("update public.profiles set role='bidder' where id=$1", [
    bidder,
  ]);
  await db.query(
    "insert into public.bidders(user_id,workspace_id) values($1,$2)",
    [bidder, w],
  );
  p = (
    await db.query<{ id: string }>(
      "insert into public.candidate_profiles(workspace_id,identifier,candidate_name,retention_months) values($1,'Retention','Name',1) returning id",
      [w],
    )
  ).rows[0].id;
  r = (
    await db.query<{ id: string }>(
      "insert into public.resumes(workspace_id,bidder_id,profile_id,identifier,candidate_name) values($1,$2,$3,'Retention','Name') returning id",
      [w, bidder, p],
    )
  ).rows[0].id;
  // This row predates the feature, so migration must preserve all three as Unspecified.
  await db.query(
    "insert into public.retained_bid_daily_aggregates(workspace_id,bidder_id,profile_id,resume_id,report_day,metric,record_count) values($1,$2,$3,$4,'2024-07-01','found',3)",
    [w, bidder, p, r],
  );
  for (const f of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql") && f >= migration)
    .sort())
    await db.exec(readFileSync(`supabase/migrations/${f}`, "utf8"));
}, 60000);
afterAll(async () => {
  await db?.close();
});
it("upgrades preexisting retained counts to unspecified without inventing arrangements", async () => {
  const v = await report();
  expect(v.comparisons.profiles).toEqual([
    {
      id: p,
      label: "Retention",
      found: 3,
      foundApplied: 3,
      arrangements: {
        remote: { found: 0, foundApplied: 0 },
        onsiteHybrid: { found: 0, foundApplied: 0 },
        unspecified: { found: 3, foundApplied: 3 },
      },
    },
  ]);
  await db.exec("reset role");
  expect(
    (
      await db.query(
        "select remote_count::integer,onsite_count::integer,hybrid_count::integer from public.retained_bid_daily_aggregates",
      )
    ).rows,
  ).toEqual([{ remote_count: 0, onsite_count: 0, hybrid_count: 0 }]);
});
it("rejects negative, null or excessive retained arrangement counts", async () => {
  await db.exec("reset role");
  for (const assignment of [
    "remote_count=-1",
    "onsite_count=-1",
    "hybrid_count=-1",
    "remote_count=null",
    "remote_count=2,onsite_count=1,hybrid_count=1",
  ])
    await expect(
      db.query(`update public.retained_bid_daily_aggregates set ${assignment}`),
    ).rejects.toThrow(/constraint|not-null/i);
});
it("retains cleanup-time arrangements when merging legacy counts and reconciles before and after idempotent cleanup", async () => {
  await db.exec("reset role; begin");
  try {
    const bids = (
      await db.query<{ id: string; company: string }>(
        `insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,arrangement,found_at,applied,application_method,rate_cents,applied_at,first_applied_at,interview_scheduled,deleted_at)
      values ($1,$2,$3,'Remote','Engineer','https://retain/remote','https://retain/remote','remote','2024-07-01 05:00Z',true,'manual',100,'2024-08-01 05:00Z','2024-07-02 05:00Z',true,null),
      ($1,$2,$3,'Onsite','Engineer','https://retain/onsite','https://retain/onsite','onsite','2024-07-02 04:59:59Z',true,'manual',200,'2024-08-01 05:00Z','2024-07-02 05:00Z',false,null),
      ($1,$2,$3,'OldRemote','Engineer','https://retain/old-remote','https://retain/old-remote','remote','2024-07-01 12:00Z',true,'manual',600,'2024-08-01 05:00Z','2024-07-02 05:00Z',false,null),
      ($1,$2,$3,'Hybrid','Engineer','https://retain/hybrid','https://retain/hybrid','hybrid','2024-07-01 12:00Z',true,'manual',300,'2024-08-01 05:00Z','2024-07-02 05:00Z',false,null),
      ($1,$2,$3,'Unapplied','Engineer','https://retain/unapplied','https://retain/unapplied','remote','2024-07-01 12:00Z',false,null,null,null,null,false,null),
      ($1,$2,$3,'Recent','Engineer','https://retain/recent','https://retain/recent','remote','2024-07-01 12:00Z',true,'manual',400,now(),now(),false,null),
      ($1,$2,$3,'Trash','Engineer','https://retain/trash','https://retain/trash','remote','2024-07-01 12:00Z',true,'manual',500,'2024-08-01 05:00Z','2024-07-02 05:00Z',false,now()) returning id,company`,
        [w, bidder, r],
      )
    ).rows;
    await db.query(
      "update public.bids set arrangement='hybrid',review_status='approved',review_revision=1 where company='Remote'",
    );
    const remote = bids.find((b) => b.company === "Remote")!.id;
    const file = (
      await db.query<{ id: string }>(
        "insert into public.files(workspace_id,bidder_id,kind,bid_id,filename,mime,size_bytes,storage_path,created_by,review_revision,finalized,sha256) values($1,$2,'screenshot',$3,'proof.png','image/png',100,'retention/proof.png',$2,1,true,repeat('a',64)) returning id",
        [w, bidder, remote],
      )
    ).rows[0].id;
    await db.query("update public.bids set evidence_file_id=$1 where id=$2", [
      file,
      remote,
    ]);
    await db.query(
      "insert into public.bid_events(bid_id,actor_id,event) values($1,$2,'created')",
      [remote, bidder],
    );
    const before = await report();
    expect(before.totals).toEqual({
      found: 9,
      foundApplied: 8,
      appliedActivity: 5,
      trackedApplications: 5,
      trackedInterviews: 1,
    });
    expect(before.comparisons.profiles).toEqual([
      {
        id: p,
        label: "Retention",
        found: 9,
        foundApplied: 8,
        arrangements: {
          remote: { found: 3, foundApplied: 2 },
          onsiteHybrid: { found: 3, foundApplied: 3 },
          unspecified: { found: 3, foundApplied: 3 },
        },
      },
    ]);
    expect(await cleanup()).toEqual({
      deletedApplications: 5,
      storageTasksQueued: 1,
      limit: 10,
    });
    const after = await report();
    expect(after.totals).toEqual(before.totals);
    expect(after.financial).toEqual(before.financial);
    expect(after.comparisons).toEqual(before.comparisons);
    await db.exec("reset role");
    expect(
      (
        await db.query(
          "select record_count::integer,remote_count::integer,onsite_count::integer,hybrid_count::integer from public.retained_bid_daily_aggregates where metric='found'",
        )
      ).rows,
    ).toEqual([
      { record_count: 7, remote_count: 1, onsite_count: 1, hybrid_count: 2 },
    ]);
    expect(
      (await db.query("select company from public.bids order by company")).rows,
    ).toEqual([{ company: "Recent" }, { company: "Unapplied" }]);
    expect(
      (await db.query("select id from public.files where id=$1", [file])).rows,
    ).toHaveLength(0);
    expect(
      (
        await db.query("select id from public.bid_events where bid_id=$1", [
          remote,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(
      (await db.query("select storage_path from public.storage_cleanup_tasks"))
        .rows,
    ).toEqual([{ storage_path: "retention/proof.png" }]);
    expect(await cleanup()).toEqual({
      deletedApplications: 0,
      storageTasksQueued: 0,
      limit: 10,
    });
    expect((await report()).comparisons).toEqual(before.comparisons);
  } finally {
    await db.exec("rollback; reset role");
  }
});
it("respects cleanup limits and protects service-only execution", async () => {
  await asUser();
  await expect(
    db.query("select public.process_candidate_retention(1)"),
  ).rejects.toThrow(/permission denied/);
  await db.exec("reset role; begin");
  try {
    await db.query(
      `insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,arrangement,found_at,applied,application_method,rate_cents,applied_at,first_applied_at)
      select $1,$2,$3,'Limited-'||g,'Engineer','https://limit/'||g,'https://limit/'||g,'remote','2024-07-01 05:00Z',true,'manual',100,'2024-08-01 05:00Z','2024-07-02 05:00Z' from generate_series(1,2) g`,
      [w, bidder, r],
    );
    expect(await cleanup(1)).toEqual({
      deletedApplications: 1,
      storageTasksQueued: 0,
      limit: 1,
    });
    expect(
      (
        await db.query<{ n: number }>(
          "select count(*)::integer n from public.bids",
        )
      ).rows[0].n,
    ).toBe(1);
    expect(await cleanup(1)).toEqual({
      deletedApplications: 1,
      storageTasksQueued: 0,
      limit: 1,
    });
    expect(await cleanup(1)).toEqual({
      deletedApplications: 0,
      storageTasksQueued: 0,
      limit: 1,
    });
  } finally {
    await db.exec("rollback; reset role");
  }
});
