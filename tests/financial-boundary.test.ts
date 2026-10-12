import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

let db: PGlite;
const client = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const bidder = "00000000-0000-4000-8000-000000000003";
let workspace: string, resume: string, bid: string;
async function asUser(id: string) {
  await db.exec(
    `reset role; set role authenticated; select set_config('request.jwt.claim.sub','${id}',false); select set_config('request.jwt.claim.role','authenticated',false);`,
  );
}
async function approveBidAsClient(bidId: string) {
  await asUser(client);
  const version = (
    await db.query<{ version: number }>(
      "select version from public.bids where id=$1",
      [bidId],
    )
  ).rows[0].version;
  await db.query("select public.review_bid($1,'approved',null,$2)", [
    bidId,
    version,
  ]);
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
  await db.close();
});
it("denies direct money but preserves safe listing and edits", async () => {
  await asUser(bidder);
  await expect(db.query("select rate_cents from bids")).rejects.toThrow(
    /permission denied/,
  );
  const result = (
    await db.query<{ value: { rows: Record<string, unknown>[] } }>(
      "select list_bids('{}') value",
    )
  ).rows[0].value;
  expect(result.rows.length).toBe(1);
  expect(result.rows[0]).not.toHaveProperty("rate_cents");
  const edited = (
    await db.query<{ value: { row: Record<string, unknown> } }>(
      "select update_bid_cell($1,'company','Changed',-1) value",
      [bid],
    )
  ).rows[0].value;
  expect(edited.row).not.toHaveProperty("rate_cents");
});
it("limits financial reads to authorized managers and preserves zero/null", async () => {
  await asUser(bidder);
  await expect(db.query("select manager_financial_values() ")).rejects.toThrow(
    /Access denied/,
  );
  await db.exec("reset role");
  await db.query("update bidders set default_rate_cents=0 where user_id=$1", [
    bidder,
  ]);
  await asUser(client);
  const result = (
    await db.query<{
      value: {
        bidders: Record<string, number | null>;
        resumes: Record<string, number | null>;
      };
    }>(
      "select manager_financial_values(array[$1]::uuid[],array[$2]::uuid[]) value",
      [bidder, resume],
    )
  ).rows[0].value;
  expect(result.bidders[bidder]).toBe(0);
  expect(result.resumes[resume]).toBeNull();
  await asUser(other);
  await expect(
    db.query("select manager_financial_values(array[$1]::uuid[])", [bidder]),
  ).rejects.toThrow(/Access denied/);
});

it("blocks wildcard, predicates, ordering, embeddings and event details while safe counts work", async () => {
  await asUser(bidder);
  for (const query of [
    "select * from bids",
    "select * from bidders",
    "select * from resumes",
    "select id from bids where rate_cents is null",
    "select id from bids order by rate_cents",
    "select user_id from bidders where default_rate_cents=0",
    "select id from resumes order by rate_override_cents",
    "select id from bids where exists(select 1 from resumes r where r.id=bids.resume_id and r.rate_override_cents is null)",
    "select details from bid_events",
    "select earned_cents from retained_bid_daily_aggregates",
  ])
    await expect(db.query(query)).rejects.toThrow(/permission denied/);
  expect(
    (await db.query<{ count: number }>("select count(*)::int count from bids"))
      .rows[0].count,
  ).toBe(1);
  expect(
    (await db.query("select id,event from bid_events")).rows.length,
  ).toBeGreaterThan(0);
  expect((await db.query("select * from invitations")).rows).toEqual([]);
});
it("guards legacy money reports against bidders, inactive and unapproved callers", async () => {
  await asUser(bidder);
  for (const query of [
    "select dashboard_performance(current_date,current_date)",
    "select earnings_performance(current_date,current_date)",
    "select retained_aggregate_summary()",
  ])
    await expect(db.query(query)).rejects.toThrow(/Access denied/);
  await db.exec("reset role");
  await db.query("update profiles set archived=true where id=$1", [client]);
  await asUser(client);
  await expect(db.query("select manager_financial_values()")).rejects.toThrow(
    /Access denied/,
  );
  await db.exec("reset role");
  await db.query(
    "update profiles set archived=false,approval_status='pending' where id=$1",
    [client],
  );
  await asUser(client);
  await expect(db.query("select manager_financial_values()")).rejects.toThrow(
    /Access denied/,
  );
  await db.exec("reset role");
  await db.query("update profiles set approval_status='approved' where id=$1", [
    client,
  ]);
});
it("preserves manager money including overrides and service access, validates every request and total size", async () => {
  await db.exec("reset role");
  await db.query("update resumes set rate_override_cents=175 where id=$1", [
    resume,
  ]);
  await db.query("update bids set rate_cents=0 where id=$1", [bid]);
  await asUser(client);
  const value = (
    await db.query<{
      value: { resumes: Record<string, number>; bids: Record<string, number> };
    }>(
      "select manager_financial_values('{}',array[$1]::uuid[],array[$2]::uuid[]) value",
      [resume, bid],
    )
  ).rows[0].value;
  expect(value.resumes[resume]).toBe(175);
  expect(value.bids[bid]).toBe(0);
  await expect(
    db.query(
      "select manager_financial_values(array_fill($1::uuid,array[1001]))",
      [bidder],
    ),
  ).rejects.toThrow(/Maximum 1000/);
  await expect(
    db.query("select manager_financial_values(array[$1,$2]::uuid[])", [
      bidder,
      other,
    ]),
  ).rejects.toThrow(/Access denied/);
  await db.exec("reset role; set role service_role");
  expect((await db.query("select rate_cents from bids")).rows).toEqual([
    { rate_cents: 0 },
  ]);
});
it("redacts successful editing, stale editing, resubmission and stale resubmission responses without changing audit", async () => {
  await asUser(bidder);
  const version = (
    await db.query<{ version: number }>(
      "select version from bids where id=$1",
      [bid],
    )
  ).rows[0].version;
  const edited = (
    await db.query<{ value: { ok: boolean; row: Record<string, unknown> } }>(
      "select update_bid_cell($1,'company','New company',$2) value",
      [bid, version],
    )
  ).rows[0].value;
  expect(edited.ok).toBe(true);
  expect(edited.row).not.toHaveProperty("rate_cents");
  const conflict = (
    await db.query<{
      value: { conflict: boolean; row: Record<string, unknown> };
    }>("select update_bid_cell($1,'company','New company',$2) value", [
      bid,
      version,
    ])
  ).rows[0].value;
  expect(conflict.conflict).toBe(true);
  expect(conflict.row).not.toHaveProperty("rate_cents");
  await db.exec("reset role");
  await db.query("update bids set review_status='rejected' where id=$1", [bid]);
  await asUser(bidder);
  const current = (
    await db.query<{ version: number }>(
      "select version from bids where id=$1",
      [bid],
    )
  ).rows[0].version;
  const stale = (
    await db.query<{
      value: { conflict: boolean; row: Record<string, unknown> };
    }>("select resubmit_bid($1,-1) value", [bid])
  ).rows[0].value;
  expect(stale.conflict).toBe(true);
  expect(stale.row).not.toHaveProperty("rate_cents");
  const fresh = (
    await db.query<{
      value: { conflict: boolean; row: Record<string, unknown> };
    }>("select resubmit_bid($1,$2) value", [bid, current])
  ).rows[0].value;
  expect(fresh.conflict).toBe(false);
  expect(fresh.row).not.toHaveProperty("rate_cents");
  await db.exec("reset role");
  const audit = (
    await db.query<{ details: { after: Record<string, unknown> } }>(
      "select details from bid_events where bid_id=$1 and event='edited' order by created_at desc limit 1",
      [bid],
    )
  ).rows[0].details;
  expect(audit.after).toHaveProperty("rate_cents", 0);
});
it("keeps both list endpoints invoker scoped and denies anonymous execution after cutover", async () => {
  await asUser(other);
  for (const name of ["list_bids", "list_bids_v2"]) {
    const value = (await db.query<{ value: { rows: unknown[] } }>(`select public.${name}('{}') value`)).rows[0].value;
    expect(value.rows).toEqual([]);
    const privileges = (await db.query<{ definer: boolean; anon: boolean; authenticated: boolean }>(
      "select p.prosecdef definer,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1", [name],
    )).rows[0];
    expect(privileges).toEqual({ definer: false, anon: false, authenticated: true });
  }
});
