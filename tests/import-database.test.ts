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
  await db?.close();
});
it("classifies only duplicate creation as typed blocking", async () => {
  const original = (
    await db.query<{ company: string; role_name: string; url: string }>(
      "select company,role_name,url from public.bids where id=$1",
      [bid],
    )
  ).rows[0];
  const counts = (
    await db.query(
      "select (select count(*) from public.bids) bids,(select count(*) from public.bid_events) events",
    )
  ).rows;
  await expect(
    db.query("select public.save_bid(null,$1,$2,$3,$4,'','remote','open')", [
      resume,
      original.company,
      original.role_name,
      original.url,
    ]),
  ).rejects.toMatchObject({ code: "PBC01", message: "Blocked" });
  expect(
    (
      await db.query(
        "select (select count(*) from public.bids) bids,(select count(*) from public.bid_events) events",
      )
    ).rows,
  ).toEqual(counts);
  await expect(
    db.query(
      "select public.save_bid(null,$1,'','Engineer','https://input.test/a','','remote','open')",
      [resume],
    ),
  ).rejects.toMatchObject({
    code: "P0001",
    message: "Company and role are required",
  });
});
it("persists and replays a zero-row receipt, rejecting changed payloads", async () => {
  const rows = [
    {
      company: "",
      role_name: "Engineer",
      url: "https://zero.test/a",
      source: "",
      arrangement: "remote",
      job_status: "open",
    },
  ];
  const request = "33333333-3333-4333-8333-333333333333";
  const args = [resume, "2026-01-01", JSON.stringify(rows), [7], request];
  const first = (
    await db.query<{ result: { ids: string[] } }>(
      "select public.import_bids_reviewed($1,$2,$3,$4,$5) result",
      args,
    )
  ).rows[0].result;
  expect(first.ids).toEqual([]);
  expect(
    (
      await db.query(
        "select request_id from public.bid_import_receipts where request_id=$1",
        [request],
      )
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await db.query<{ result: unknown }>(
        "select public.import_bids_reviewed($1,$2,$3,$4,$5) result",
        args,
      )
    ).rows[0].result,
  ).toEqual(first);
  await expect(
    db.query("select public.import_bids_reviewed($1,$2,$3,$4,$5)", [
      resume,
      "2026-01-01",
      JSON.stringify([{ ...rows[0], company: "Fixed" }]),
      [7],
      request,
    ]),
  ).rejects.toThrow(/different content/);
});

it("lets eligible later rows claim URLs rejected for invalid earlier rows and makes the first eligible duplicate win", async () => {
  const row = {
    company: "Eligible",
    role_name: "Engineer",
    url: "https://batch.test/one",
    source: "",
    arrangement: "remote",
    job_status: "open",
  };
  const rows = [{ ...row, company: "" }, row, { ...row, company: "Later" }];
  const errors = (
    await db.query<{ errors: { row: number; code: string }[] }>(
      "select public.validate_bid_import($1,'2026-01-01',$2) errors",
      [resume, JSON.stringify(rows)],
    )
  ).rows[0].errors;
  expect(errors.some((e) => e.row === 1)).toBe(true);
  expect(errors.some((e) => e.row === 2)).toBe(false);
  expect(errors).toContainEqual(
    expect.objectContaining({ row: 3, code: "batch_duplicate_url" }),
  );
  const result = (
    await db.query<{ result: { ids: string[]; sourceRows: number[] } }>(
      "select public.import_bids_reviewed($1,'2026-01-01',$2,$3,$4) result",
      [
        resume,
        JSON.stringify(rows),
        [1, 2, 3],
        "44444444-4444-4444-8444-444444444444",
      ],
    )
  ).rows[0].result;
  expect(result.ids).toHaveLength(1);
  expect(result.sourceRows).toEqual([2]);
});
it("imports 500 allowed rows and replays the same receipt without duplicate writes", async () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({
    company: `Capacity ${i}`,
    role_name: "Engineer",
    url: `https://capacity.test/${i}`,
    source: "",
    arrangement: "remote",
    job_status: "open",
  }));
  const args = [
    resume,
    "2026-01-01",
    JSON.stringify(rows),
    rows.map((_, i) => i + 1),
    "55555555-5555-4555-8555-555555555555",
  ];
  const first = (
    await db.query<{ result: { ids: string[] } }>(
      "select public.import_bids_reviewed($1,$2,$3,$4,$5) result",
      args,
    )
  ).rows[0].result;
  expect(first.ids).toHaveLength(500);
  expect(
    (
      await db.query<{ result: unknown }>(
        "select public.import_bids_reviewed($1,$2,$3,$4,$5) result",
        args,
      )
    ).rows[0].result,
  ).toEqual(first);
});
it("rechecks new active conflicts at commit and returns only remaining rows", async () => {
  const row = {
    company: "Race",
    role_name: "Engineer",
    url: "https://race.test/one",
    source: "",
    arrangement: "remote",
    job_status: "open",
  };
  expect(
    (
      await db.query<{ errors: unknown[] }>(
        "select public.validate_bid_import($1,'2026-01-01',$2) errors",
        [resume, JSON.stringify([row])],
      )
    ).rows[0].errors,
  ).toEqual([]);
  await db.query(
    "select public.save_bid(null,$1,$2,$3,$4,'','remote','open')",
    [resume, row.company, row.role_name, row.url],
  );
  const second = {
    ...row,
    company: "Still eligible",
    url: "https://race.test/two",
  };
  const result = (
    await db.query<{ result: { ids: string[]; sourceRows: number[] } }>(
      "select public.import_bids_reviewed($1,'2026-01-01',$2,$3,$4) result",
      [
        resume,
        JSON.stringify([row, second]),
        [8, 9],
        "66666666-6666-4666-8666-666666666666",
      ],
    )
  ).rows[0].result;
  expect(result.ids).toHaveLength(1);
  expect(result.sourceRows).toEqual([9]);
});

it.each([
  "restricted_company",
  "restricted_role",
  "restricted_link",
  "duplicate_company_role",
  "company_limit",
])(
  "creation %s returns no restriction details and writes nothing",
  async (kind) => {
    await db.exec("begin; reset role");
    try {
      const original = (
        await db.query<{ company: string; role_name: string }>(
          "select company,role_name from public.bids where id=$1",
          [bid],
        )
      ).rows[0];
      const company =
        kind === "duplicate_company_role" || kind === "company_limit"
          ? original.company
          : "Rule company";
      const role =
        kind === "duplicate_company_role" ? original.role_name : "Rule role";
      const url = `https://rules.test/${kind}`;
      if (kind.startsWith("restricted")) {
        const column = {
          restricted_company: "restricted_companies",
          restricted_role: "restricted_roles",
          restricted_link: "restricted_links",
        }[kind as "restricted_company" | "restricted_role" | "restricted_link"];
        await db.query(
          `update public.candidate_profiles set ${column}=array[$1] where id=(select profile_id from public.resumes where id=$2)`,
          [
            kind === "restricted_company"
              ? company
              : kind === "restricted_role"
                ? role
                : "rules.test",
            resume,
          ],
        );
      }
      if (kind === "company_limit")
        await db.query(
          "update public.candidate_profiles set max_bids_per_company=1 where id=(select profile_id from public.resumes where id=$1)",
          [resume],
        );
      await asUser(bidder);
      const counts = (
        await db.query(
          "select (select count(*) from public.bids) bids,(select count(*) from public.bid_events) events",
        )
      ).rows;
      try {
        await db.query(
          "select public.save_bid(null,$1,$2,$3,$4,'','remote','open')",
          [resume, company, role, url],
        );
        throw new Error("Expected blocking");
      } catch (error) {
        expect(error).toMatchObject({ code: "PBC01", message: "Blocked" });
        expect((error as { detail?: string }).detail).toBeUndefined();
        expect((error as { hint?: string }).hint).toBeUndefined();
      }
      // A raised database error aborts the surrounding test transaction.
      await db.exec("rollback");
      expect(
        (
          await db.query(
            "select (select count(*) from public.bids) bids,(select count(*) from public.bid_events) events",
          )
        ).rows,
      ).toEqual(counts);
    } finally {
      await db.exec("rollback");
      await asUser(bidder);
    }
  },
);
