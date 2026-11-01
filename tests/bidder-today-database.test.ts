import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

const owner = "40000000-0000-4000-8000-000000000001";
const bidder = "40000000-0000-4000-8000-000000000002";
const other = "40000000-0000-4000-8000-000000000003";
const admin = "40000000-0000-4000-8000-000000000004";
// Chicago's fall-back day is 25 hours long; bounds are deliberately literal.
const rangeFrom = "2026-11-01T05:00:00.000Z";
const rangeTo = "2026-11-02T06:00:00.000Z";
const ids: Record<string, string> = {};
let db: PGlite;
type Listing = {
  rows: { id: string; company: string; found_at: string; applied: boolean }[];
  total: number;
  statusCounts: Record<string, number>;
};
async function asUser(id = bidder) {
  await db.exec("reset role; set role authenticated");
  await db.query(
    "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",
    [id],
  );
}
async function list(query: Record<string, unknown> = {}) {
  return (
    await db.query<{ value: Listing }>(
      "select public.list_bids_v2($1::jsonb) value",
      [
        JSON.stringify({
          rangeFrom,
          rangeTo,
          includeOlderUnapplied: true,
          pageSize: 100,
          ...query,
        }),
      ],
    )
  ).rows[0].value;
}
const names = (result: Listing) => result.rows.map((row) => row.company);
const today = [
  "Today last",
  "Today second hour",
  "Today first hour",
  "Today start",
];
const backlog = ["Backlog pending", "Backlog approved", "Backlog rejected"];

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
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  }
  await db.query(
    "insert into auth.users(id,email) values($1,'owner@today.test'),($2,'bidder@today.test'),($3,'other@today.test'),($4,'admin@today.test')",
    [owner, bidder, other, admin],
  );
  await db.exec("update public.profiles set approval_status='approved'");
  await db.query(
    "update public.profiles set role='bidder' where id in ($1,$2)",
    [bidder, other],
  );
  await db.query("update public.profiles set role='admin' where id=$1", [
    admin,
  ]);
  const workspace = (
    await db.query<{ id: string }>(
      "select id from public.workspaces where owner_id=$1",
      [owner],
    )
  ).rows[0].id;
  for (const actor of [bidder, other]) {
    await db.query(
      "insert into public.bidders(user_id,workspace_id,default_rate_cents) values($1,$2,100)",
      [actor, workspace],
    );
  }
  const profile = (
    await db.query<{ id: string }>(
      "insert into public.candidate_profiles(workspace_id,identifier,candidate_name) values($1,'TODAY','Candidate') returning id",
      [workspace],
    )
  ).rows[0].id;
  const resumes: Record<string, string> = {};
  for (const actor of [bidder, other]) {
    resumes[actor] = (
      await db.query<{ id: string }>(
        "insert into public.resumes(workspace_id,bidder_id,profile_id,identifier,candidate_name) values($1,$2,$3,'TODAY','Candidate') returning id",
        [workspace, actor, profile],
      )
    ).rows[0].id;
  }
  const seed = [
    ["Today start", rangeFrom, true, "approved", false, bidder],
    [
      "Today first hour",
      "2026-11-01T06:30:00Z",
      true,
      "approved",
      false,
      bidder,
    ],
    [
      "Today second hour",
      "2026-11-01T07:30:00Z",
      true,
      "approved",
      false,
      bidder,
    ],
    [
      "Today last",
      "2026-11-02T05:59:59.999999Z",
      false,
      "pending",
      false,
      bidder,
    ],
    [
      "Backlog pending",
      "2026-11-01T04:59:59.999999Z",
      false,
      "pending",
      false,
      bidder,
    ],
    [
      "Backlog approved",
      "2026-10-30T12:00:00Z",
      false,
      "approved",
      false,
      bidder,
    ],
    [
      "Backlog rejected",
      "2026-10-29T12:00:00Z",
      false,
      "rejected",
      false,
      bidder,
    ],
    ["Older applied", "2026-11-01T04:59:58Z", true, "approved", false, bidder],
    ["Tomorrow", rangeTo, false, "pending", false, bidder],
    ["Deleted backlog", "2026-10-28T12:00:00Z", false, "pending", true, bidder],
    [
      "Other bidder backlog",
      "2026-10-27T12:00:00Z",
      false,
      "approved",
      false,
      other,
    ],
  ] as const;
  for (const [company, foundAt, applied, review, deleted, actor] of seed) {
    ids[company] = randomUUID();
    const url = `https://today.test/${ids[company]}`;
    await db.query(
      `insert into public.bids(id,workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,source,arrangement,job_status,found_at,applied,review_status,deleted_at,application_method,rate_cents,applied_at,first_applied_at)
      values($1,$2,$3,$4,$5,'Engineer',$6,$6,'Board','remote','open',$7,$8,$9,case when $10 then now() else null end,case when $8 then 'manual' else null end,case when $8 then 100 else null end,case when $8 then $11::timestamptz else null end,case when $8 then $11::timestamptz else null end)`,
      [
        ids[company],
        workspace,
        actor,
        resumes[actor],
        company,
        url,
        foundAt,
        applied,
        review,
        deleted,
        rangeFrom,
      ],
    );
  }
}, 60000);
beforeEach(async () => {
  await db.exec("reset role; begin");
  await asUser();
});
afterEach(async () => {
  await db.exec("rollback; reset role");
});
afterAll(async () => {
  await db?.close();
});

it("includes every older unapplied review state with accurate counts and stable pages", async () => {
  const result = await list();
  expect(names(result)).toEqual([...today, ...backlog]);
  expect(result.total).toBe(7);
  expect(result.statusCounts).toEqual({
    all: 7,
    applied: 3,
    unapplied: 4,
    pending_review: 2,
  });
  expect(names(await list({ pageSize: 3, pageIndex: 1 }))).toEqual([
    "Today start",
    "Backlog pending",
    "Backlog approved",
  ]);
  expect(
    names(await list({ sorting: [{ id: "found_at", desc: false }] })),
  ).toEqual([...today, ...backlog].reverse());
  expect(names(await list({ status: "unapplied" }))).toEqual([
    "Today last",
    ...backlog,
  ]);
  expect(names(await list({ status: "applied" }))).toEqual(today.slice(1));
});
it("retains legacy results when the flag is omitted or false", async () => {
  expect(names(await list({ includeOlderUnapplied: undefined }))).toEqual(
    today,
  );
  expect(names(await list({ includeOlderUnapplied: false }))).toEqual(today);
});
it.each([owner, admin])(
  "does not expand manager reads even with a forged flag: %s",
  async (actor) => {
    await asUser(actor);
    expect(names(await list())).toEqual(today);
  },
);
it("preserves search, column dates, status and scope filters for the expanded population", async () => {
  expect(names(await list({ search: "Backlog" }))).toEqual(backlog);
  expect(names(await list({ columnFilters: { company: "approved" } }))).toEqual(
    ["Backlog approved"],
  );
  expect(
    names(
      await list({
        columnFilters: { found_at: { from: "2026-11-01", to: "2026-11-01" } },
      }),
    ),
  ).toEqual(today);
  expect(
    names(await list({ columnFilters: { review_status: "rejected" } })),
  ).toEqual(["Backlog rejected"]);
  expect((await list({ scopeBidderId: other })).total).toBe(0);
  expect((await list({ source: "Missing" })).total).toBe(0);
  expect((await list({ ipCountry: "US" })).total).toBe(0);
});
it("does not expand Trash or an unbounded query", async () => {
  expect((await list({ trash: true })).total).toBe(0);
  const result = await list({ rangeFrom: null, rangeTo: null });
  expect(result.total).toBe(9);
  expect(names(result)).not.toContain("Deleted backlog");
  expect(names(result)).not.toContain("Other bidder backlog");
});
it("removes an applied older URL and restores it when unapplied again", async () => {
  await db.exec("reset role");
  await db.query(
    "update public.bids set applied=true,application_method='manual',rate_cents=100,applied_at=$2,first_applied_at=$2 where id=$1",
    [ids["Backlog approved"], rangeFrom],
  );
  await asUser();
  expect((await list()).total).toBe(6);
  expect(names(await list())).not.toContain("Backlog approved");
  await db.exec("reset role");
  await db.query(
    "update public.bids set applied=false,applied_at=null,application_method=null where id=$1",
    [ids["Backlog approved"]],
  );
  await asUser();
  expect((await list()).total).toBe(7);
  expect(names(await list())).toContain("Backlog approved");
});
it("leaves stored dates and actual found-today reporting unchanged", async () => {
  const snapshot = async () =>
    (
      await db.query(
        "select id,found_at,created_at,applied_at from public.bids order by id",
      )
    ).rows;
  const report = async () =>
    (
      await db.query<{ value: { totals: { found: number } } }>(
        "select public.dashboard_performance_v2('2026-11-01','2026-11-01',null,null,null) value",
      )
    ).rows[0].value;
  const before = await snapshot();
  expect((await report()).totals.found).toBe(4);
  expect((await list()).total).toBe(7);
  expect(await snapshot()).toEqual(before);
  expect((await report()).totals.found).toBe(4);
});
