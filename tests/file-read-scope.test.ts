// Historical projection comparisons exclude the new retention timestamp; its contract is tested separately.
// Migration 009 is replayed here to compare its historical file visibility.
// Added list fields are verified by retention/location suites, not present in 009.
const legacyProjection = (value: unknown) => JSON.parse(JSON.stringify(value,(key,item) =>
  ["screenshot_uploaded_at","applicationLocation","countryOptions"].includes(key) ? undefined : item));
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const migration = "supabase/migrations/202610120009_file_read_scope.sql";
const actors = {
  owner: "00000000-0000-4000-8000-000000000001",
  other: "00000000-0000-4000-8000-000000000002",
  admin: "00000000-0000-4000-8000-000000000003",
  bidder: "00000000-0000-4000-8000-000000000004",
  second: "00000000-0000-4000-8000-000000000005",
  foreign: "00000000-0000-4000-8000-000000000006",
};
const firstNames = [
  "current",
  "historical",
  "mismatched-bid",
  "pending",
  "resume",
  "trashed",
];
const localNames = [...firstNames, "second-current"].sort();
const foreignNames = ["foreign-current", "foreign-pointer", "foreign-resume"];
const allNames = [...localNames, ...foreignNames].sort();
let db: PGlite;
let workspace: string, foreignWorkspace: string;
let primaryBid: string, primaryResume: string;
let nextFile = 101;

async function asUser(id: string) {
  await db.exec("reset role; set role authenticated");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec(
    "select set_config('request.jwt.claim.role','authenticated',false)",
  );
}
async function oldPolicy() {
  await db.exec(
    "reset role; alter policy file_read on public.files using(public.can_read(workspace_id,bidder_id))",
  );
}
async function newPolicy() {
  await db.exec("reset role");
  // Before 009 exists, execute the old behavior so the plan regression can
  // demonstrate the missing optimization rather than a missing-file error.
  if (existsSync(migration)) await db.exec(readFileSync(migration, "utf8"));
}
async function visibility() {
  const result: Record<
    string,
    { files: string[]; storage: string[]; listing: unknown }
  > = {};
  for (const [name, id] of Object.entries(actors)) {
    await asUser(id);
    result[name] = {
      files: (
        await db.query<{ filename: string }>(
          "select filename from public.files order by filename",
        )
      ).rows.map((row) => row.filename),
      storage: (
        await db.query<{ name: string }>(
          "select name from storage.objects order by name",
        )
      ).rows.map((row) => row.name),
      listing: (
        await db.query<{ value: unknown }>(
          "select public.list_bids_v2('{}') value",
        )
      ).rows[0].value,
    };
  }
  return result;
}
async function addFile(
  name: string,
  ws: string,
  user: string,
  target: string,
  kind = "screenshot",
  finalized = true,
) {
  const id = `00000000-0000-4000-8000-${String(nextFile++).padStart(12, "0")}`;
  await db.query(
    `insert into public.files(id,workspace_id,bidder_id,kind,bid_id,resume_id,filename,mime,size_bytes,storage_path,created_by,finalized,review_revision)
    values($1,$2,$3,$4,$5,$6,$7,$8,10240,$9,$3,$10,case when $4='screenshot' then 1 else null end)`,
    [
      id,
      ws,
      user,
      kind,
      kind === "screenshot" ? target : null,
      kind === "resume" ? target : null,
      name,
      kind === "resume" ? "application/pdf" : "image/png",
      `scope-test/${name}`,
      finalized,
    ],
  );
  await db.query(
    "insert into storage.objects(bucket_id,name) values('private-files',$1)",
    [`scope-test/${name}`],
  );
  return id;
}
interface Plan {
  "Node Type": string;
  "Function Name"?: string;
  "Actual Loops": number;
  "Actual Rows": number;
  Plans?: Plan[];
}
async function filePlan() {
  return (
    await db.query<{
      "QUERY PLAN": { Plan: Plan; "Execution Time": number }[];
    }>(
      "explain (analyze, buffers, format json) select count(*) from public.files",
    )
  ).rows[0]["QUERY PLAN"][0];
}
function scopeNodes(node: Plan): Plan[] {
  return [
    ...(node["Function Name"] === "readable_bid_scope" ? [node] : []),
    ...(node.Plans?.flatMap(scopeNodes) ?? []),
  ];
}
async function listingPlan() {
  const body = (
    await db.query<{ body: string }>(
      "select prosrc body from pg_proc where oid='public.list_bids_v2(jsonb)'::regprocedure",
    )
  ).rows[0].body;
  // These helpers explain size sorting / searched queries, which use the
  // retained grouped branch. Keep the complete SELECT including locations.
  const statementStart = [...body.matchAll(/with (?:application_locations|filtered) as (?:not )?materialized/g)].at(-1)?.index;
  if (statementStart === undefined) throw new Error("Retained list SELECT missing");
  let statement = body.slice(statementStart,body.indexOf(" into result;",statementStart));
  const locals = {
    p_query: "($1::jsonb)",
    page_index: "0",
    page_size: "100",
    sort_id: "'screenshot_size_bytes'",
    sort_desc: "false",
    columns: "'{}'::jsonb",
    bidder_filter: "''",
    resume_filter: "''",
    bidder_matches: "'{}'::uuid[]",
    resume_matches: "'{}'::uuid[]",
    can_view_sizes: "true",
    include_older_unapplied: "false",
  };
  for (const [variable, value] of Object.entries(locals))
    statement = statement.replace(new RegExp(`\\b${variable}\\b`, "g"), value);
  return (
    await db.query<{
      "QUERY PLAN": { Plan: Plan; "Execution Time": number }[];
    }>(`explain (analyze, buffers, format json) ${statement}`, [
      JSON.stringify({ search: "Scope batch" }),
    ])
  ).rows[0]["QUERY PLAN"][0];
}
function allNodes(node: Plan): Plan[] {
  return [node, ...(node.Plans?.flatMap(allNodes) ?? [])];
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb); alter table storage.objects enable row level security;
    grant usage on schema auth,storage to authenticated,service_role; grant all on storage.objects to authenticated,service_role;`);
  for (const file of readdirSync("supabase/migrations")
    .filter(
      (name) => name.endsWith(".sql") && !name.endsWith("_file_read_scope.sql"),
    )
    .sort())
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  for (const [name, id] of Object.entries(actors))
    await db.query("insert into auth.users(id,email) values($1,$2)", [
      id,
      `${name}@scope.test`,
    ]);
  // This read-projection fixture intentionally creates corrupt/unverified pointers as the database owner.
  await db.exec("alter table public.bids disable trigger snapshot_screenshot; alter table public.bids disable trigger cleanup_replaced_screenshot; alter table public.files disable trigger stamp_verified_file");
  await db.exec("update public.profiles set approval_status='approved'");
  await db.query("update public.profiles set role='admin' where id=$1", [
    actors.admin,
  ]);
  await db.query(
    "update public.profiles set role='bidder' where id=any($1::uuid[])",
    [[actors.bidder, actors.second, actors.foreign]],
  );
  workspace = (
    await db.query<{ id: string }>(
      "select id from public.workspaces where owner_id=$1",
      [actors.owner],
    )
  ).rows[0].id;
  foreignWorkspace = (
    await db.query<{ id: string }>(
      "select id from public.workspaces where owner_id=$1",
      [actors.other],
    )
  ).rows[0].id;
  const bids: Record<string, string> = {},
    resumes: Record<string, string> = {};
  for (const [name, ws] of [
    ["bidder", workspace],
    ["second", workspace],
    ["foreign", foreignWorkspace],
  ] as const) {
    const user = actors[name];
    await db.query(
      "insert into public.bidders(user_id,workspace_id,default_rate_cents) values($1,$2,125)",
      [user, ws],
    );
    const profile = (
      await db.query<{ id: string }>(
        "insert into public.candidate_profiles(workspace_id,identifier,candidate_name) values($1,$2,$2) returning id",
        [ws, name],
      )
    ).rows[0].id;
    resumes[name] = (
      await db.query<{ id: string }>(
        "insert into public.resumes(workspace_id,bidder_id,profile_id,identifier,candidate_name) values($1,$2,$3,$4,$4) returning id",
        [ws, user, profile, name],
      )
    ).rows[0].id;
    bids[name] = (
      await db.query<{ id: string }>(
        "insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,arrangement,review_status,review_revision) values($1,$2,$3,$4,'Engineer',$5,$5,'remote','approved',1) returning id",
        [ws, user, resumes[name], name, `https://scope.test/${name}`],
      )
    ).rows[0].id;
  }
  primaryBid = bids.bidder;
  primaryResume = resumes.bidder;
  const current = await addFile(
    "current",
    workspace,
    actors.bidder,
    primaryBid,
  );
  await db.query("update public.bids set evidence_file_id=$1 where id=$2", [
    current,
    primaryBid,
  ]);
  await addFile("historical", workspace, actors.bidder, primaryBid);
  await addFile(
    "pending",
    workspace,
    actors.bidder,
    primaryBid,
    "screenshot",
    false,
  );
  await addFile("resume", workspace, actors.bidder, primaryResume, "resume");
  await addFile("mismatched-bid", workspace, actors.bidder, bids.foreign);
  await addFile("second-current", workspace, actors.second, bids.second);
  await addFile(
    "foreign-current",
    foreignWorkspace,
    actors.foreign,
    bids.foreign,
  );
  await addFile(
    "foreign-resume",
    foreignWorkspace,
    actors.foreign,
    resumes.foreign,
    "resume",
  );
  const foreignPointer = await addFile(
    "foreign-pointer",
    foreignWorkspace,
    actors.foreign,
    primaryBid,
  );
  await db.query("update public.bids set evidence_file_id=$1 where id=$2", [
    foreignPointer,
    bids.second,
  ]);
  const trash = (
    await db.query<{ id: string }>(
      "insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,arrangement,review_status,review_revision) values($1,$2,$3,'Trash','Engineer','https://scope.test/trash','https://scope.test/trash','remote','approved',1) returning id",
      [workspace, actors.bidder, primaryResume],
    )
  ).rows[0].id;
  await addFile("trashed", workspace, actors.bidder, trash);
  await db.query("update public.bids set deleted_at=now() where id=$1", [
    trash,
  ]);
}, 60000);
beforeEach(async () => {
  await db.exec("reset role; begin");
  await oldPolicy();
});
afterEach(async () => {
  await db.exec("rollback; reset role");
});
afterAll(async () => {
  await db.close();
});

it.each([
  ["unchanged", null, null],
  [
    "archived bidder profile",
    "profiles",
    { id: actors.bidder, archived: true },
  ],
  [
    "archived bidder membership",
    "bidders",
    { id: actors.bidder, archived: true },
  ],
  ["archived owner", "profiles", { id: actors.owner, archived: true }],
  [
    "pending owner",
    "profiles",
    { id: actors.owner, approval_status: "pending" },
  ],
  [
    "rejected owner",
    "profiles",
    { id: actors.owner, approval_status: "rejected" },
  ],
  [
    "pending bidder",
    "profiles",
    { id: actors.bidder, approval_status: "pending" },
  ],
  [
    "rejected bidder",
    "profiles",
    { id: actors.bidder, approval_status: "rejected" },
  ],
  [
    "pending admin",
    "profiles",
    { id: actors.admin, approval_status: "pending" },
  ],
  [
    "rejected admin",
    "profiles",
    { id: actors.admin, approval_status: "rejected" },
  ],
  ["archived admin", "profiles", { id: actors.admin, archived: true }],
] as const)(
  "preserves every role's file/storage/query visibility with %s",
  async (name, table, change) => {
    if (table && change) {
      const field = "archived" in change ? "archived" : "approval_status";
      const value =
        "archived" in change ? change.archived : change.approval_status;
      await db.query(
        `update public.${table} set ${field}=$1 where ${table === "bidders" ? "user_id" : "id"}=$2`,
        [value, change.id],
      );
    }
    const before = await visibility();
    const ownerDisabled = [
      "archived owner",
      "pending owner",
      "rejected owner",
    ].includes(name);
    expect(before.owner.files).toEqual(ownerDisabled ? [] : localNames);
    expect(before.other.files).toEqual(foreignNames);
    expect(before.admin.files).toEqual(
      name === "archived admin" ? [] : allNames,
    );
    expect(before.bidder.files).toEqual(
      ownerDisabled || name.startsWith("archived bidder") ? [] : firstNames,
    );
    expect(before.second.files).toEqual(
      ownerDisabled ? [] : ["second-current"],
    );
    expect(before.foreign.files).toEqual(foreignNames);
    await newPolicy();
    expect(legacyProjection(await visibility())).toEqual(legacyProjection(before));
  },
);

it("keeps file visibility when profiles/resumes are archived and attachment metadata is unavailable", async () => {
  await db.query("update public.resumes set archived=true where id=$1", [
    primaryResume,
  ]);
  await db.exec("update public.candidate_profiles set archived=true");
  const before = await visibility();
  expect(before.owner.files).toEqual(localNames);
  expect(before.bidder.files).toEqual(firstNames);
  await newPolicy();
  expect(legacyProjection(await visibility())).toEqual(legacyProjection(before));
});

it("revokes access on the next statement without caching permissions beyond the query", async () => {
  await newPolicy();
  await asUser(actors.bidder);
  expect((await db.query("select id from public.files")).rows).toHaveLength(6);
  await db.exec("reset role");
  await db.query("update public.bidders set archived=true where user_id=$1", [
    actors.bidder,
  ]);
  await asUser(actors.bidder);
  expect((await db.query("select id from public.files")).rows).toHaveLength(0);
  await asUser(actors.owner);
  expect((await db.query("select id from public.files")).rows).toHaveLength(7);
});

it("retains grants, invoker mode, service visibility and financial/direct-write/anonymous boundaries", async () => {
  const privileges = async () =>
    (
      await db.query(
        "select relacl from pg_class where oid in ('public.files'::regclass,'storage.objects'::regclass) order by oid",
      )
    ).rows;
  const before = await privileges();
  await newPolicy();
  expect(await privileges()).toEqual(before);
  const invoker = (
    await db.query<{ definer: boolean }>(
      "select prosecdef definer from pg_proc where oid='public.list_bids_v2(jsonb)'::regprocedure",
    )
  ).rows[0].definer;
  expect(invoker).toBe(false);
  for (const user of [actors.owner, actors.admin, actors.bidder]) {
    await asUser(user);
    for (const statement of [
      "select rate_cents from public.bids",
      "insert into public.files(filename) values('blocked')",
      "update public.files set filename='blocked'",
      "delete from public.files",
    ]) {
      await db.exec("savepoint forbidden");
      await expect(db.exec(statement)).rejects.toThrow(/permission denied/);
      await db.exec("rollback to forbidden; release forbidden");
    }
  }
  await db.exec("reset role; set role service_role");
  expect((await db.query("select id from public.files")).rows).toHaveLength(10);
  await db.exec("reset role; set role anon; savepoint anonymous");
  await expect(db.query("select id from public.files")).rejects.toThrow(
    /permission denied/,
  );
  await db.exec(
    "rollback to anonymous; release anonymous; savepoint anonymous",
  );
  await expect(
    db.query("select * from private.readable_bid_scope()"),
  ).rejects.toThrow(/permission denied/);
  await db.exec("rollback to anonymous; release anonymous");
});

it("preserves storage upload eligibility for pending own screenshots and blocks finalized/foreign uploads", async () => {
  await newPolicy();
  await asUser(actors.bidder);
  await db.exec("reset role");
  await db.query("delete from storage.objects where name='scope-test/pending'");
  await asUser(actors.bidder);
  await db.query(
    "insert into storage.objects(bucket_id,name) values('private-files','scope-test/pending')",
  );
  for (const name of ["current", "foreign-current"]) {
    await db.exec("savepoint upload");
    await expect(
      db.query(
        "insert into storage.objects(bucket_id,name) values('private-files',$1)",
        [`scope-test/${name}`],
      ),
    ).rejects.toThrow(/row-level security/);
    await db.exec("rollback to upload; release upload");
  }
});

it("evaluates file authorization once per trusted membership scope instead of per file", async () => {
  await db.query(
    `insert into public.files(workspace_id,bidder_id,kind,bid_id,filename,mime,size_bytes,storage_path,created_by,finalized,review_revision)
    select $1,$2,'screenshot',$3,'Bulk '||n,'image/png',10240,'bulk/'||n,$2,true,1 from generate_series(1,10000) n`,
    [workspace, actors.bidder, primaryBid],
  );
  await db.exec("analyze public.files");
  await asUser(actors.owner);
  const before = await filePlan();
  await newPolicy();
  await asUser(actors.owner);
  const after = await filePlan();
  console.info(
    `file-read scope 10k: old ${before["Execution Time"]}ms, new ${after["Execution Time"]}ms`,
  );
  expect(after.Plan["Actual Rows"]).toBe(1);
  const scopes = scopeNodes(after.Plan);
  expect(scopes).toHaveLength(1);
  expect(scopes[0]["Actual Loops"]).toBe(1);
  expect(scopes[0]["Actual Rows"]).toBe(2);
}, 60000);

it("counts varied sizes once in the shared evidence snapshot and preserves exact 008 rows", async () => {
  await db.query(
    `insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,arrangement,review_status,review_revision)
    select $1,$2,$3,'Scope batch '||n,'Engineer','https://scope-batch.test/'||n,'https://scope-batch.test/'||n,'remote','approved',1 from generate_series(1,2400) n`,
    [workspace, actors.bidder, primaryResume],
  );
  await db.query(
    `insert into public.files(workspace_id,bidder_id,kind,bid_id,filename,mime,size_bytes,storage_path,created_by,finalized,review_revision)
    select workspace_id,bidder_id,'screenshot',id,'Batch.png','image/png',2048+substring(company from '[0-9]+$')::integer%700,id::text,$1,true,1 from public.bids where company like 'Scope batch %'`,
    [actors.bidder],
  );
  await db.exec(
    "update public.bids b set evidence_file_id=f.id from public.files f where f.bid_id=b.id and b.company like 'Scope batch %'; analyze public.bids; analyze public.files",
  );
  await asUser(actors.owner);
  const query = JSON.stringify({
    search: "Scope batch",
    pageSize: 100,
    sorting: [{ id: "screenshot_size_bytes", desc: false }],
  });
  const read = async () =>
    (
      await db.query<{
        value: {
          total: number;
          rows: {
            screenshot_size_bytes: number;
            screenshot_size_match_count: number;
          }[];
        };
      }>("select public.list_bids_v2($1::jsonb) value", [query])
    ).rows[0].value;
  const before = await read(),
    beforePlan = await listingPlan();
  expect(before.total).toBe(2400);
  expect(
    before.rows
      .slice(0, 3)
      .map((row) => [
        row.screenshot_size_bytes,
        row.screenshot_size_match_count,
      ]),
  ).toEqual([
    [2048, 3],
    [2048, 3],
    [2048, 3],
  ]);
  expect(
    before.rows
      .slice(3, 7)
      .map((row) => [
        row.screenshot_size_bytes,
        row.screenshot_size_match_count,
      ]),
  ).toEqual([
    [2049, 4],
    [2049, 4],
    [2049, 4],
    [2049, 4],
  ]);
  await newPolicy();
  await asUser(actors.owner);
  expect(legacyProjection(await read())).toEqual(legacyProjection(before));
  const afterPlan = await listingPlan();
  console.info(
    `varied evidence 2,400/700 sizes: old ${beforePlan["Execution Time"]}ms, new ${afterPlan["Execution Time"]}ms`,
  );
  const windows = allNodes(afterPlan.Plan).filter(
    (node) => node["Node Type"] === "WindowAgg" && node["Actual Rows"] === 2400,
  );
  expect(windows).toHaveLength(1);
  expect(windows[0]["Actual Loops"]).toBe(1);
  expect(
    allNodes(afterPlan.Plan).filter(
      (node) => node["Node Type"] === "Aggregate" && node["Actual Loops"] > 1,
    ),
  ).toEqual([]);
}, 60000);
