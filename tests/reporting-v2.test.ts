import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, afterEach, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
interface Report {
  range: { from: string; to: string; bucketUnit: string; bucketSize: number };
  totals: Record<string, number>;
  financial?: { earningsCents: number; earningsCount: number };
  series: {
    from: string;
    to: string;
    found: number;
    foundApplied: number;
    applied: number;
  }[];
  comparisons: { bidders: Comparison[]; profiles: Comparison[] };
  groups: {
    id: string;
    label: string;
    count: number;
    cents: number;
    applied: number;
    interviews: number;
    conversion: number | null;
  }[];
}
interface Comparison {
  id: string;
  label: string;
  found: number;
  foundApplied: number;
  arrangements: Record<
    "remote" | "onsiteHybrid" | "unspecified",
    { found: number; foundApplied: number }
  >;
}
let db: PGlite;
const owner = "00000000-0000-4000-8000-000000000001";
const bidder = "00000000-0000-4000-8000-000000000002";
const other = "00000000-0000-4000-8000-000000000003";
let w: string, p: string, r: string;
async function asUser(id: string) {
  await db.exec(
    `reset role; set role authenticated; select set_config('request.jwt.claim.sub','${id}',false); select set_config('request.jwt.claim.role','authenticated',false)`,
  );
}
async function report(
  name: string,
  from: string | null = null,
  to: string | null = null,
  group = "bidder",
) {
  return (
    await db.query<{ report: Report }>(
      `select public.${name}($1::date,$2::date,null,null,null${name === "dashboard_performance_v2" ? "" : ",$3"}) report`,
      name === "dashboard_performance_v2" ? [from, to] : [from, to, group],
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
  for (const f of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync(`supabase/migrations/${f}`, "utf8"));
  await db.query(
    "insert into auth.users(id,email) values($1,'owner@report.test'),($2,'bidder@report.test'),($3,'other@report.test')",
    [owner, bidder, other],
  );
  await db.exec("update public.profiles set approval_status='approved'");
  w = (
    await db.query<{ id: string }>(
      "select id from public.workspaces where owner_id=$1",
      [owner],
    )
  ).rows[0].id;
  await db.query(
    "update public.profiles set role='bidder',display_name='Same' where id=$1",
    [bidder],
  );
  await db.query(
    "insert into public.bidders(user_id,workspace_id,default_rate_cents) values($1,$2,100)",
    [bidder, w],
  );
  p = (
    await db.query<{ id: string }>(
      "insert into public.candidate_profiles(workspace_id,identifier,candidate_name) values($1,'Profile','Name') returning id",
      [w],
    )
  ).rows[0].id;
  r = (
    await db.query<{ id: string }>(
      "insert into public.resumes(workspace_id,bidder_id,profile_id,identifier,candidate_name) values($1,$2,$3,'Profile','Name') returning id",
      [w, bidder, p],
    )
  ).rows[0].id;
  await db.query(
    `insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,arrangement,found_at,applied,application_method,rate_cents,applied_at,first_applied_at,interview_scheduled) values
 ($1,$2,$3,'A','Engineer','https://a.test','https://a.test','remote','2020-01-01 06:00Z',true,'manual',100,'2024-01-02 06:00Z','2020-01-02 06:00Z',true),
 ($1,$2,$3,'B','Engineer','https://b.test','https://b.test','remote','2024-01-01 05:59Z',false,null,null,null,null,false)`,
    [w, bidder, r],
  );
  await db.query(
    `insert into public.retained_bid_daily_aggregates(workspace_id,bidder_id,profile_id,resume_id,report_day,metric,record_count,earned_cents,tracked_count,interview_count) values
 ($1,$2,$3,$4,'1990-01-01','found',2,0,0,0),($1,$2,$3,$4,'1990-01-02','earning',2,900,1,1),($1,$2,$3,$4,'1990-01-02','applied_activity',2,0,0,0)`,
    [w, bidder, p, r],
  );
  await asUser(owner);
}, 60000);
afterEach(async () => {
  await db.exec("rollback; reset role");
  await asUser(owner);
});
afterAll(async () => {
  await db?.close();
});
it("includes old retained all-time counts with a bounded series", async () => {
  const v = await report("dashboard_performance_v2");
  expect(v.range.from).toBe("1990-01-01");
  expect(v.series.length).toBeLessThanOrEqual(120);
  expect(v.totals).toEqual({
    found: 4,
    foundApplied: 3,
    appliedActivity: 3,
    trackedApplications: 2,
    trackedInterviews: 2,
  });
  expect(v.financial).toEqual({ earningsCents: 1000, earningsCount: 3 });
  expect(v.comparisons.profiles).toEqual([
    {
      id: p,
      label: "Profile",
      found: 4,
      foundApplied: 3,
      arrangements: {
        remote: { found: 2, foundApplied: 1 },
        onsiteHybrid: { found: 0, foundApplied: 0 },
        unspecified: { found: 2, foundApplied: 2 },
      },
    },
  ]);
});
it("preserves historical money and interviews in earnings groups", async () => {
  const v = await report("earnings_performance_v2");
  expect(v.totals.cents).toBe(1000);
  expect(v.groups).toHaveLength(1);
  expect(v.groups[0]).toMatchObject({
    count: 3,
    cents: 1000,
    applied: 2,
    interviews: 2,
  });
});
it("returns interview cohorts without financial fields", async () => {
  const v = await report("interview_performance");
  expect(v.totals).toEqual({
    applied: 2,
    interviews: 2,
    excludedApplications: 1,
  });
  expect(v.groups[0]).toMatchObject({
    applied: 2,
    interviews: 2,
    conversion: 100,
  });
  expect(JSON.stringify(v)).not.toMatch(/cents|earn/i);
});
it("uses CT boundaries and latest activity independently of first application", async () => {
  const v = await report(
    "dashboard_performance_v2",
    "2024-01-01",
    "2024-01-02",
  );
  expect(v.totals.found).toBe(0);
  expect(v.totals.appliedActivity).toBe(1);
  expect(v.totals.trackedApplications).toBe(0);
});
it("denies financial access and strips bidder dashboard financial data", async () => {
  await asUser(bidder);
  expect(await report("dashboard_performance_v2")).not.toHaveProperty(
    "financial",
  );
  await expect(report("earnings_performance_v2")).rejects.toThrow(
    /Access denied/,
  );
  expect((await report("interview_performance")).totals.applied).toBe(2);
  await asUser(owner);
});
it("isolates tenants and validates partial/reversed ranges", async () => {
  await asUser(other);
  expect((await report("dashboard_performance_v2")).totals.found).toBe(0);
  await asUser(owner);
  await expect(
    report("dashboard_performance_v2", "2024-01-01"),
  ).rejects.toThrow(/range/i);
  await expect(
    report("interview_performance", "2024-01-02", "2024-01-01"),
  ).rejects.toThrow(/range/i);
});
it("merges shared profiles and bidders across assignments without duplicate keys", async () => {
  await db.exec("reset role; begin");
  const b2 = "00000000-0000-4000-8000-000000000004";
  await db.query(
    "insert into auth.users(id,email) values($1,'second@report.test')",
    [b2],
  );
  await db.query(
    "update public.profiles set role='bidder',display_name='Same' where id=$1",
    [b2],
  );
  await db.query(
    "insert into public.bidders(user_id,workspace_id) values($1,$2)",
    [b2, w],
  );
  const p2 = (
    await db.query<{ id: string }>(
      "insert into public.candidate_profiles(workspace_id,identifier,candidate_name) values($1,'Profile2','Name') returning id",
      [w],
    )
  ).rows[0].id;
  const r2 = (
    await db.query<{ id: string }>(
      "insert into public.resumes(workspace_id,bidder_id,profile_id,identifier,candidate_name) values($1,$2,$3,'Profile','Name') returning id",
      [w, b2, p],
    )
  ).rows[0].id;
  const r3 = (
    await db.query<{ id: string }>(
      "insert into public.resumes(workspace_id,bidder_id,profile_id,identifier,candidate_name) values($1,$2,$3,'Profile2','Name') returning id",
      [w, bidder, p2],
    )
  ).rows[0].id;
  for (const [b, pr, re] of [
    [b2, p, r2],
    [bidder, p2, r3],
  ])
    await db.query(
      "insert into public.retained_bid_daily_aggregates(workspace_id,bidder_id,profile_id,resume_id,report_day,metric,record_count,earned_cents,tracked_count,interview_count) values($1,$2,$3,$4,'1990-01-01','found',3,0,0,0),($1,$2,$3,$4,'1990-01-01','earning',3,600,2,1)",
      [w, b, pr, re],
    );
  await asUser(owner);
  const v = await report("dashboard_performance_v2");
  expect(v.comparisons.bidders.every((g) => g.label === "Same")).toBe(true);
  expect(v.comparisons.profiles.find((g) => g.id === p)?.arrangements).toEqual({
    remote: { found: 2, foundApplied: 1 },
    onsiteHybrid: { found: 0, foundApplied: 0 },
    unspecified: { found: 5, foundApplied: 5 },
  });
  for (const groups of [v.comparisons.bidders, v.comparisons.profiles]) {
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.id)).size).toBe(2);
    expect(groups.reduce((n: number, g) => n + g.found, 0)).toBe(
      v.totals.found,
    );
    expect(groups.reduce((n: number, g) => n + g.foundApplied, 0)).toBe(
      v.totals.foundApplied,
    );
  }
  for (const group of ["bidder", "profile", "assignment"]) {
    const e = await report("earnings_performance_v2", null, null, group);
    expect(new Set(e.groups.map((g) => g.id)).size).toBe(e.groups.length);
    expect(e.groups.reduce((n: number, g) => n + g.cents, 0)).toBe(
      e.totals.cents,
    );
    expect(e.groups.reduce((n: number, g) => n + g.interviews, 0)).toBe(
      e.totals.trackedInterviews,
    );
  }
  await asUser(b2);
  const own = await report("dashboard_performance_v2");
  expect(own.totals.found).toBe(3);
  expect(own.comparisons.profiles).toHaveLength(1);
  expect(own.comparisons.profiles[0]).toMatchObject({
    id: p,
    arrangements: {
      remote: { found: 0, foundApplied: 0 },
      onsiteHybrid: { found: 0, foundApplied: 0 },
      unspecified: { found: 3, foundApplied: 3 },
    },
  });
  await expect(
    db.query("select public.dashboard_performance_v2(null,null,null,$1,null)", [
      bidder,
    ]),
  ).rejects.toThrow(/Access denied/);
  await db.exec("rollback; reset role");
  await asUser(owner);
});
it("handles history-only untracked cohorts with null conversion", async () => {
  await db.exec("reset role; begin");
  await db.query("delete from public.bids where workspace_id=$1", [w]);
  await db.query(
    "update public.retained_bid_daily_aggregates set tracked_count=0,interview_count=0 where workspace_id=$1",
    [w],
  );
  await asUser(owner);
  const i = await report("interview_performance");
  expect(i.totals).toEqual({
    applied: 0,
    interviews: 0,
    excludedApplications: 2,
  });
  expect(i.groups[0].conversion).toBeNull();
  const e = await report("earnings_performance_v2");
  expect(e.groups[0].cents).toBe(900);
  expect(e.totals.resumes).toBe(1);
  await db.exec("rollback; reset role");
  await asUser(owner);
});
it("clips aligned buckets and bounds very long ranges to 120 points", async () => {
  for (const [from, to, unit] of [
    ["2024-01-03", "2024-01-10", "day"],
    ["2024-01-03", "2024-06-10", "week"],
    ["2000-01-03", "2009-12-10", "month"],
    ["1800-03-12", "2026-10-12", "year"],
  ]) {
    const v = await report("dashboard_performance_v2", from, to);
    expect(v.range.bucketUnit).toBe(unit);
    expect(v.series.length).toBeLessThanOrEqual(120);
    expect(v.series[0].from).toBe(from);
    expect(v.series.at(-1)?.to).toBe(to);
    expect(v.series.reduce((n: number, g) => n + g.found, 0)).toBe(
      v.totals.found,
    );
  }
});
it("excludes trash and unapplied rows from current cohorts and separates reapplication activity", async () => {
  await db.exec("reset role; begin");
  await db.query("update public.bids set deleted_at=now() where applied");
  await asUser(owner);
  expect((await report("earnings_performance_v2")).totals.count).toBe(2);
  await db.exec("reset role");
  await db.query(
    "update public.bids set deleted_at=null,applied=false,application_method=null,applied_at=null,interview_scheduled=false where first_applied_at is not null",
  );
  await asUser(owner);
  expect((await report("earnings_performance_v2")).totals.count).toBe(2);
  await db.exec("reset role");
  await db.query(
    "update public.bids set applied=true,application_method='manual',applied_at='2024-02-01 06:00Z' where first_applied_at is not null",
  );
  await asUser(owner);
  expect(
    (await report("earnings_performance_v2", "2020-01-01", "2020-01-03")).totals
      .count,
  ).toBe(1);
  expect(
    (await report("dashboard_performance_v2", "2024-02-01", "2024-02-01"))
      .totals.appliedActivity,
  ).toBe(1);
  await db.exec("rollback; reset role");
  await asUser(owner);
});
it("keeps private event helpers inaccessible to authenticated users", async () => {
  await expect(
    db.query(
      "select * from private.report_events(null,null,null,null,null,false)",
    ),
  ).rejects.toThrow(/permission denied/);
});

it("validates cross-workspace filters and preserves archived bidder permissions", async () => {
  // Obtain the other workspace through the owner, not a privileged report call.
  await asUser(other);
  const otherWorkspace = (
    await db.query<{ id: string }>(
      "select id from public.workspaces where owner_id=$1",
      [other],
    )
  ).rows[0].id;
  await asUser(owner);
  await expect(
    db.query("select public.dashboard_performance_v2(null,null,$1,null,null)", [
      otherWorkspace,
    ]),
  ).rejects.toThrow(/Access denied/);
  await asUser(bidder);
  await expect(
    db.query("select public.interview_performance(null,null,$1,null,null)", [
      otherWorkspace,
    ]),
  ).rejects.toThrow(/Access denied/);
  await db.exec("reset role; begin");
  await db.query("update public.bidders set archived=true where user_id=$1", [
    bidder,
  ]);
  await asUser(bidder);
  expect((await report("dashboard_performance_v2")).totals.found).toBe(0);
  await db.exec("rollback; reset role");
  await asUser(owner);
});
it("keeps fallback raw-reader timestamp bounds in generic-plan index conditions", async () => {
  await db.exec("reset role; begin");
  try {
    await db.query(
      `insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,arrangement,found_at,applied,application_method,rate_cents,applied_at,first_applied_at)
      select $1,$2,$3,'Generic-'||g,'Engineer','https://generic.test/'||g,'https://generic.test/'||g,'remote','2000-01-01'::timestamptz + g*interval '1 hour',true,'manual',100,'2000-01-01'::timestamptz + g*interval '1 hour','2000-01-01'::timestamptz + g*interval '1 hour' from generate_series(1,5000) g`,
      [w, bidder, r],
    );
    await db.query(
      `insert into public.retained_bid_daily_aggregates(workspace_id,bidder_id,profile_id,resume_id,report_day,metric,record_count,tracked_count) select $1,$2,$3,$4,'2000-01-01'::date+g,'earning',1,1 from generate_series(1,5000) g`,
      [w, bidder, p, r],
    );
    await db.exec(
      "analyze public.bids; analyze public.retained_bid_daily_aggregates",
    );
    for (const helper of ["report_events", "dashboard_report_events"]) {
      const source = (
        await db.query<{ prosrc: string }>(
          "select prosrc from pg_proc where oid=$1::regprocedure",
          [
            `private.${helper}_legacy(date,date,uuid,uuid,uuid${helper === "report_events" ? ",boolean" : ""})`,
          ],
        )
      ).rows[0].prosrc;
      const args = [
        "p_from",
        "p_to",
        "p_workspace",
        "p_bidder",
        "p_profile",
        "p_cohort_only",
      ];
      if (helper === "dashboard_report_events") args.pop();
      const query = args.reduce(
        (sql, arg, index) =>
          sql.replace(new RegExp(`\\b${arg}\\b`, "g"), `$${index + 1}`),
        source,
      );
      await db.exec(
        "set local plan_cache_mode='force_generic_plan'; set local enable_seqscan=off",
      );
      await db.exec(
        `prepare report_events_generic(date,date,uuid,uuid,uuid${helper === "report_events" ? ",boolean" : ""}) as ${query}`,
      );
      const plan = (
        await db.query<{ "QUERY PLAN": unknown }>(
          `explain (format json) execute report_events_generic('2024-01-01','2024-01-02',null,null,null${helper === "report_events" ? ",false" : ""})`,
        )
      ).rows[0]["QUERY PLAN"];
      const conditions: string[] = [];
      function visit(value: unknown): void {
        if (Array.isArray(value)) {
          value.forEach(visit);
        } else if (value && typeof value === "object") {
          for (const [key, item] of Object.entries(value)) {
            if (key === "Index Cond" && typeof item === "string")
              conditions.push(item);
            else visit(item);
          }
        }
      }
      visit(plan);
      for (const column of [
        "found_at",
        "applied_at",
        "first_applied_at",
        "report_day",
      ]) {
        expect(
          conditions.some(
            (condition) =>
              condition.includes(`${column} >=`) &&
              condition.includes(`${column} <`),
          ),
          `${column} bounds must be indexable under a generic plan`,
        ).toBe(true);
      }
      await db.exec("deallocate report_events_generic");
    }
  } finally {
    await db.exec("rollback; reset role");
    await asUser(owner);
  }
});
it("compresses same-day assignment events while preserving live and retained measures", async () => {
  await db.exec("reset role; begin");
  try {
    await db.query(
      `insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,arrangement,found_at,applied,application_method,rate_cents,applied_at,first_applied_at)
      values($1,$2,$3,'Compressed','Engineer','https://compressed.test','https://compressed.test','remote','2020-01-01 06:00Z',true,'manual',200,'2024-01-02 06:00Z','2020-01-02 06:00Z')`,
      [w, bidder, r],
    );
    await db.query(
      `insert into public.retained_bid_daily_aggregates(workspace_id,bidder_id,profile_id,resume_id,report_day,metric,record_count,earned_cents,tracked_count,interview_count)
      values($1,$2,$3,$4,'2020-01-01','found',2,0,0,0),($1,$2,$3,$4,'2020-01-02','earning',2,300,1,1),($1,$2,$3,$4,'2024-01-02','applied_activity',2,0,0,0)`,
      [w, bidder, p, r],
    );
    const events = (
      await db.query<{
        metric: string;
        n: number;
        found_applied: number;
        tracked: number;
        interviews: number;
        cents: number;
        retained: number;
      }>(
        "select metric,n::integer,found_applied::integer,tracked::integer,interviews::integer,cents::integer,retained::integer from private.report_events('2020-01-01','2024-01-02',null,null,null,false)",
      )
    ).rows;
    expect(events.filter((row) => row.metric === "earning")).toEqual([
      {
        metric: "earning",
        n: 4,
        found_applied: 0,
        tracked: 3,
        interviews: 2,
        cents: 600,
        retained: 2,
      },
    ]);
    expect(events.filter((row) => row.metric === "applied_activity")).toEqual([
      {
        metric: "applied_activity",
        n: 4,
        found_applied: 0,
        tracked: 0,
        interviews: 0,
        cents: 0,
        retained: 0,
      },
    ]);
    await asUser(owner);
    const reportValue = await report(
      "earnings_performance_v2",
      "2020-01-01",
      "2024-01-02",
    );
    expect(reportValue.totals).toMatchObject({
      count: 4,
      cents: 600,
      retainedCount: 2,
      trackedApplications: 3,
      trackedInterviews: 2,
      excludedInterviewCount: 1,
    });
    expect(reportValue.groups[0]).toMatchObject({
      count: 4,
      cents: 600,
      applied: 3,
      interviews: 2,
    });
  } finally {
    await db.exec("rollback; reset role");
    await asUser(owner);
  }
});

it("splits the found-date CT cohort by current arrangement and application state", async () => {
  await db.exec("reset role; begin");
  try {
    await db.query(
      `insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,arrangement,found_at,applied,application_method,rate_cents,applied_at,first_applied_at,deleted_at)
      values ($1,$2,$3,'Remote','Engineer','https://mixed/remote','https://mixed/remote','remote','2024-07-01 05:00Z',true,'manual',100,'2024-08-01 05:00Z','2024-07-02 05:00Z',null),
      ($1,$2,$3,'Onsite','Engineer','https://mixed/onsite','https://mixed/onsite','onsite','2024-07-02 04:59:59Z',true,'manual',100,'2024-08-01 05:00Z','2024-07-02 05:00Z',null),
      ($1,$2,$3,'Hybrid','Engineer','https://mixed/hybrid','https://mixed/hybrid','hybrid','2024-07-01 12:00Z',false,null,null,null,null,null),
      ($1,$2,$3,'Before','Engineer','https://mixed/before','https://mixed/before','remote','2024-07-01 04:59:59Z',false,null,null,null,null,null),
      ($1,$2,$3,'After','Engineer','https://mixed/after','https://mixed/after','hybrid','2024-07-02 05:00Z',false,null,null,null,null,null),
      ($1,$2,$3,'Trash','Engineer','https://mixed/trash','https://mixed/trash','onsite','2024-07-01 12:00Z',true,'manual',100,'2024-07-01 12:00Z','2024-07-01 12:00Z',now())`,
      [w, bidder, r],
    );
    await asUser(owner);
    const v = await report(
      "dashboard_performance_v2",
      "2024-07-01",
      "2024-07-01",
    );
    expect(v.totals).toMatchObject({
      found: 3,
      foundApplied: 2,
      appliedActivity: 0,
    });
    for (const g of [v.comparisons.bidders[0], v.comparisons.profiles[0]])
      expect(g.arrangements).toEqual({
        remote: { found: 1, foundApplied: 1 },
        onsiteHybrid: { found: 2, foundApplied: 1 },
        unspecified: { found: 0, foundApplied: 0 },
      });
    await db.exec("reset role");
    await db.query(
      "update public.bids set arrangement='hybrid' where url='https://mixed/remote'",
    );
    await asUser(owner);
    expect(
      (await report("dashboard_performance_v2", "2024-07-01", "2024-07-01"))
        .comparisons.profiles[0].arrangements,
    ).toEqual({
      remote: { found: 0, foundApplied: 0 },
      onsiteHybrid: { found: 3, foundApplied: 2 },
      unspecified: { found: 0, foundApplied: 0 },
    });
  } finally {
    await db.exec("rollback; reset role");
    await asUser(owner);
  }
});
it("compresses arrangement measures into one assignment-day event without losing legacy counts", async () => {
  await db.exec("reset role; begin");
  try {
    await db.query(
      `insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,arrangement,found_at,applied,application_method,rate_cents,applied_at,first_applied_at)
      values($1,$2,$3,'R','Engineer','https://compress/r','https://compress/r','remote','2020-01-01 06:00Z',false,null,null,null,null),
      ($1,$2,$3,'H','Engineer','https://compress/h','https://compress/h','hybrid','2020-01-01 06:00Z',true,'manual',200,'2024-01-02 06:00Z','2020-01-02 06:00Z')`,
      [w, bidder, r],
    );
    await db.query(
      `insert into public.retained_bid_daily_aggregates(workspace_id,bidder_id,profile_id,resume_id,report_day,metric,record_count,remote_count,onsite_count,hybrid_count)
      values($1,$2,$3,$4,'2020-01-01','found',5,1,1,1)`,
      [w, bidder, p, r],
    );
    const events = (
      await db.query(
        "select n::integer,found_applied::integer,remote_found::integer,remote_applied::integer,onsite_hybrid_found::integer,onsite_hybrid_applied::integer,unspecified_found::integer,unspecified_applied::integer from private.dashboard_report_events('2020-01-01','2020-01-01',null,null,null) where metric='found'",
      )
    ).rows;
    expect(events).toEqual([
      {
        n: 8,
        found_applied: 7,
        remote_found: 3,
        remote_applied: 2,
        onsite_hybrid_found: 3,
        onsite_hybrid_applied: 3,
        unspecified_found: 2,
        unspecified_applied: 2,
      },
    ]);
  } finally {
    await db.exec("rollback; reset role");
    await asUser(owner);
  }
});
it("revokes direct arrangement helper execution from every browser role", async () => {
  await db.exec("reset role");
  const permissions = (
    await db.query<{ role: string; allowed: boolean }>(
      "select r role,has_function_privilege(r,'private.dashboard_report_events(date,date,uuid,uuid,uuid)','execute') allowed from unnest(array['anon','authenticated']) r",
    )
  ).rows;
  expect(permissions).toEqual([
    { role: "anon", allowed: false },
    { role: "authenticated", allowed: false },
  ]);
  await asUser(owner);
  await expect(
    db.query(
      "select * from private.dashboard_report_events(null,null,null,null,null)",
    ),
  ).rejects.toThrow(/permission denied/);
});
