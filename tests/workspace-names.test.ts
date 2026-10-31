import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const migration =
  "supabase/migrations/202610120007_workspace_display_names.sql";
const backup = "private.workspace_display_names_202610120007";
const client = "00000000-0000-4000-8000-000000000001";
const admin = "00000000-0000-4000-8000-000000000002";
const bidder = "00000000-0000-4000-8000-000000000009";
const insertedOwner = "00000000-0000-4000-8000-000000000010";
const fixtures = [
  {
    id: client,
    email: "client@test.com",
    display: " \tJordan Rivera\n ",
    old: "Custom client name",
    want: "Workspace - Jordan Rivera",
  },
  {
    id: admin,
    email: "admin@test.com",
    display: "Administrator",
    old: "Admin custom",
    want: "Workspace - Administrator",
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    email: "other@test.com",
    display: "Other",
    old: "My workspace",
    want: "Workspace - Other",
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    email: "pending@test.com",
    display: "Pending",
    old: "Pending custom",
    want: "Workspace - Pending",
  },
  {
    id: "00000000-0000-4000-8000-000000000005",
    email: "archived@test.com",
    display: "Archived",
    old: "Archived custom",
    want: "Workspace - Archived",
  },
  {
    id: "00000000-0000-4000-8000-000000000006",
    email: "fallback@test.com",
    display: "\t\n\r ",
    old: "",
    want: "Workspace - fallback",
  },
  {
    id: "00000000-0000-4000-8000-000000000007",
    email: "unicode@test.com",
    display: " Élodie 李 👩🏽‍💻 ",
    old: "Unicode custom",
    want: "Workspace - Élodie 李 👩🏽‍💻",
  },
  {
    id: "00000000-0000-4000-8000-000000000008",
    email: "@test.com",
    display: "",
    old: "Empty owner",
    want: "Workspace - Client",
  },
];
let db: PGlite;
let workspace: string;
let originalWorkspaces: Record<string, unknown>[];
let originalProfiles: Record<string, unknown>[];
let originalMemberships: Record<string, unknown>[];
let failedMigrationState:
  | {
      oldNames: { owner_id: string; name: string }[];
      backup: string | null;
      nameDefault: string | null;
    }
  | undefined;

async function asUser(id: string) {
  await db.exec("reset role; set role authenticated");
  await db.query(
    "select set_config('request.jwt.claim.sub',$1,false), set_config('request.jwt.claim.role','authenticated',false)",
    [id],
  );
}

async function prepareInsertOwner(
  display = "Profile Owner",
  email = "insert@test.com",
) {
  await db.query(
    'insert into auth.users(id,email,raw_user_meta_data) values($1,$2,\'{"display_name":"Untrusted old metadata"}\')',
    [insertedOwner, email],
  );
  await db.query("delete from public.workspaces where owner_id=$1", [
    insertedOwner,
  ]);
  await db.query("update public.profiles set display_name=$2 where id=$1", [
    insertedOwner,
    display,
  ]);
  await db.exec("set role service_role");
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
    grant usage on schema auth,storage to authenticated,service_role;
    grant all on storage.objects to authenticated,service_role;`);
  // Seed existing rows under the old schema before applying the forward migration.
  for (const file of readdirSync("supabase/migrations")
    .filter(
      (f) =>
        f.endsWith(".sql") &&
        f <= "202610120005_scoped_counts_invoker_guard.sql",
    )
    .sort()) {
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  }
  for (const fixture of fixtures) {
    await db.query("insert into auth.users(id,email) values($1,$2)", [
      fixture.id,
      fixture.email,
    ]);
    await db.query(
      "update public.profiles set display_name=$2,approval_status=case when email='pending@test.com' then 'pending' else 'approved' end,archived=(email='archived@test.com'),role=case when email='admin@test.com' then 'admin' else 'client' end where id=$1",
      [fixture.id, fixture.display],
    );
    await db.query(
      "update public.workspaces set name=$2,timezone='Europe/London',created_at='2025-01-01 00:00Z' where owner_id=$1",
      [fixture.id, fixture.old],
    );
  }
  workspace = (
    await db.query<{ id: string }>(
      "select id from public.workspaces where owner_id=$1",
      [client],
    )
  ).rows[0].id;
  await asUser(client);
  await db.query(
    "select public.invite_bidder($1,'bidder@test.com','Trusted Bidder',125)",
    [workspace],
  );
  await db.exec("reset role");
  await db.query(
    "update public.invitations set id=$1 where email='bidder@test.com'",
    [bidder],
  );
  await db.query(
    "insert into auth.users(id,email,raw_user_meta_data) values($1,'bidder@test.com','{\"display_name\":\"Forged\"}')",
    [bidder],
  );
  originalWorkspaces = (
    await db.query<Record<string, unknown>>(
      "select to_jsonb(w)-'name' as value from public.workspaces w order by id",
    )
  ).rows;
  originalProfiles = (
    await db.query<Record<string, unknown>>(
      "select * from public.profiles order by id",
    )
  ).rows;
  originalMemberships = (
    await db.query<Record<string, unknown>>(
      "select * from public.bidders order by user_id",
    )
  ).rows;
  // Leaving this absent during RED exercises the old behavior rather than failing setup.
  if (existsSync(migration)) {
    const sql = readFileSync(migration, "utf8");
    // A failure after capture must leave both the original names and schema intact.
    await db.exec(`create function public.reject_workspace_name_replacement() returns trigger language plpgsql as $$
      begin raise exception 'Simulated replacement failure'; end $$;
      create trigger reject_workspace_name_replacement before update of name on public.workspaces
      for each row execute function public.reject_workspace_name_replacement();`);
    await expect(db.exec(sql)).rejects.toThrow("Simulated replacement failure");
    await db.exec("rollback");
    failedMigrationState = {
      oldNames: (
        await db.query<{ owner_id: string; name: string }>(
          "select owner_id,name from public.workspaces order by owner_id",
        )
      ).rows,
      backup: (
        await db.query<{ value: string | null }>(
          "select to_regclass($1)::text as value",
          [backup],
        )
      ).rows[0].value,
      nameDefault: (
        await db.query<{ value: string | null }>(
          "select column_default as value from information_schema.columns where table_schema='public' and table_name='workspaces' and column_name='name'",
        )
      ).rows[0].value,
    };
    await db.exec(
      "drop trigger reject_workspace_name_replacement on public.workspaces; drop function public.reject_workspace_name_replacement()",
    );
    await db.exec(sql);
  }
}, 60000);

beforeEach(async () => {
  await db.exec("reset role; begin");
});
afterEach(async () => {
  await db.exec("rollback; reset role");
});
afterAll(async () => {
  await db.close();
});

it("replaces every existing workspace name, including custom, admin, pending and archived owners", async () => {
  const rows = (
    await db.query<{ owner_id: string; name: string }>(
      "select owner_id,name from public.workspaces order by owner_id",
    )
  ).rows;
  expect(rows).toEqual(
    fixtures.map((fixture) => ({ owner_id: fixture.id, name: fixture.want })),
  );
});

it("rolls back backup capture and schema changes when name replacement fails", () => {
  expect(failedMigrationState).toEqual({
    oldNames: fixtures.map((fixture) => ({
      owner_id: fixture.id,
      name: fixture.old,
    })),
    backup: null,
    nameDefault: "'My workspace'::text",
  });
});

it("preserves workspace settings, profile state and trusted bidder memberships during backfill", async () => {
  expect(
    (
      await db.query(
        "select to_jsonb(w)-'name' as value from public.workspaces w order by id",
      )
    ).rows,
  ).toEqual(originalWorkspaces);
  expect(
    (await db.query("select * from public.profiles order by id")).rows,
  ).toEqual(originalProfiles);
  expect(
    (await db.query("select * from public.bidders order by user_id")).rows,
  ).toEqual(originalMemberships);
});

it("records exact old and generated names for every existing workspace", async () => {
  const rows = (
    await db.query<{ owner_id: string; old_name: string; new_name: string }>(
      `select w.owner_id,b.old_name,b.new_name from ${backup} b join public.workspaces w on w.id=b.workspace_id order by w.owner_id`,
    )
  ).rows;
  expect(rows).toEqual(
    fixtures.map((fixture) => ({
      owner_id: fixture.id,
      old_name: fixture.old,
      new_name: fixture.want,
    })),
  );
});

it.each([
  { label: "omitted", name: undefined, want: "Workspace - Profile Owner" },
  { label: "null", name: null, want: "Workspace - Profile Owner" },
  { label: "empty", name: "", want: "Workspace - Profile Owner" },
  { label: "whitespace", name: " \t\n\r ", want: "Workspace - Profile Owner" },
  {
    label: "legacy default",
    name: "My workspace",
    want: "Workspace - Profile Owner",
  },
  {
    label: "padded legacy default",
    name: "\tMy workspace\n",
    want: "Workspace - Profile Owner",
  },
  {
    label: "explicit custom",
    name: "  My chosen name  ",
    want: "  My chosen name  ",
  },
])(
  "uses the authoritative profile for $label inserts while preserving custom names",
  async ({ name, want }) => {
    await prepareInsertOwner(" \tProfile Owner\n ");
    const rows =
      name === undefined
        ? (
            await db.query<{ name: string }>(
              "insert into public.workspaces(owner_id) values($1) returning name",
              [insertedOwner],
            )
          ).rows
        : (
            await db.query<{ name: string }>(
              "insert into public.workspaces(owner_id,name) values($1,$2) returning name",
              [insertedOwner, name],
            )
          ).rows;
    expect(rows[0].name).toBe(want);
  },
);

it.each([
  {
    display: " Élodie 李 👩🏽‍💻 ",
    email: "unicode-insert@test.com",
    want: "Workspace - Élodie 李 👩🏽‍💻",
  },
  {
    display: "李".repeat(90),
    email: "long@test.com",
    want: "Workspace - " + "李".repeat(88),
  },
  {
    display: " \t\n ",
    email: "fallback-insert@test.com",
    want: "Workspace - fallback-insert",
  },
  { display: "", email: " \t@test.com", want: "Workspace - Client" },
])(
  "handles Unicode, the 100 character bound and empty-owner fallback ($email)",
  async ({ display, email, want }) => {
    await prepareInsertOwner(display, email);
    const row = (
      await db.query<{ name: string; length: number }>(
        "insert into public.workspaces(owner_id) values($1) returning name,char_length(name) as length",
        [insertedOwner],
      )
    ).rows[0];
    expect(row.name).toBe(want);
    expect(row.length).toBeLessThanOrEqual(100);
  },
);

it("names public signup workspaces without granting pending clients workspace access", async () => {
  await db.query(
    "insert into auth.users(id,email,raw_user_meta_data) values($1,'signup@test.com','{\"display_name\":\"  Signup Owner  \"}')",
    [insertedOwner],
  );
  expect(
    (
      await db.query<{ name: string }>(
        "select name from public.workspaces where owner_id=$1",
        [insertedOwner],
      )
    ).rows[0].name,
  ).toBe("Workspace - Signup Owner");
  await asUser(insertedOwner);
  expect((await db.query("select * from public.workspaces")).rows).toHaveLength(
    0,
  );
});

it("keeps trusted managed provisioning in the existing workspace without creating another workspace", async () => {
  await asUser(client);
  await db.query(
    "select public.invite_bidder($1,'managed@test.com','Managed Owner',250)",
    [workspace],
  );
  await db.exec("reset role");
  await db.query(
    "update public.invitations set id=$1 where email='managed@test.com'",
    [insertedOwner],
  );
  await db.query(
    "insert into auth.users(id,email,raw_user_meta_data) values($1,'managed@test.com','{\"display_name\":\"Forged\"}')",
    [insertedOwner],
  );
  expect(
    (
      await db.query("select * from public.workspaces where owner_id=$1", [
        insertedOwner,
      ])
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await db.query(
        "select display_name,role from public.profiles where id=$1",
        [insertedOwner],
      )
    ).rows,
  ).toEqual([{ display_name: "Managed Owner", role: "bidder" }]);
  expect(
    (
      await db.query(
        "select workspace_id,default_rate_cents from public.bidders where user_id=$1",
        [insertedOwner],
      )
    ).rows,
  ).toEqual([{ workspace_id: workspace, default_rate_cents: 250 }]);
});

it("names trusted managed client workspaces from the reservation despite conflicting Auth metadata", async () => {
  await asUser(admin);
  const managedClient = (
    await db.query<{ id: string }>(
      "select public.reserve_client_account('Managed.Client@test.com','  Trusted Managed Client  ') as id",
    )
  ).rows[0].id;
  await db.exec("reset role");
  await db.query(
    "insert into auth.users(id,email,raw_user_meta_data) values($1,'managed.client@test.com','{\"display_name\":\"Conflicting metadata name\"}')",
    [managedClient],
  );
  expect(
    (
      await db.query(
        "select email,display_name,role,approval_status from public.profiles where id=$1",
        [managedClient],
      )
    ).rows,
  ).toEqual([
    {
      email: "managed.client@test.com",
      display_name: "Trusted Managed Client",
      role: "client",
      approval_status: "approved",
    },
  ]);
  expect(
    (
      await db.query(
        "select owner_id,name from public.workspaces where owner_id=$1",
        [managedClient],
      )
    ).rows,
  ).toEqual([
    { owner_id: managedClient, name: "Workspace - Trusted Managed Client" },
  ]);
  expect(
    (
      await db.query(
        "select email,display_name,created_by,consumed_at is not null as consumed from public.client_provisions where id=$1",
        [managedClient],
      )
    ).rows,
  ).toEqual([
    {
      email: "managed.client@test.com",
      display_name: "Trusted Managed Client",
      created_by: admin,
      consumed: true,
    },
  ]);
  await asUser(managedClient);
  expect(
    (
      await db.query("select name from public.workspaces where owner_id=$1", [
        managedClient,
      ])
    ).rows,
  ).toEqual([{ name: "Workspace - Trusted Managed Client" }]);
});

it("keeps workspace edits independent from Settings profile edits and admin update_client", async () => {
  await asUser(client);
  await db.query(
    "select public.save_settings('Settings Owner',null,null,null)",
  );
  expect(
    (
      await db.query<{ name: string }>(
        "select name from public.workspaces where id=$1",
        [workspace],
      )
    ).rows[0].name,
  ).toBe("Workspace - Jordan Rivera");
  await db.query(
    "select public.save_settings('Settings Owner',$1,'Chosen workspace','America/New_York')",
    [workspace],
  );
  await asUser(admin);
  await db.query("select public.update_client($1,'Admin edited owner',false)", [
    client,
  ]);
  expect(
    (
      await db.query(
        "select name,timezone from public.workspaces where id=$1",
        [workspace],
      )
    ).rows,
  ).toEqual([{ name: "Chosen workspace", timezone: "America/New_York" }]);
});

it("retains manager, bidder and pending visibility and denies direct client writes", async () => {
  await asUser(bidder);
  expect((await db.query("select id from public.workspaces")).rows).toEqual([
    { id: workspace },
  ]);
  await asUser(fixtures[3].id);
  expect(
    (await db.query("select id from public.workspaces")).rows,
  ).toHaveLength(0);
  await asUser(client);
  expect((await db.query("select id from public.workspaces")).rows).toEqual([
    { id: workspace },
  ]);
  await expect(
    db.query("update public.workspaces set name='Unauthorized' where id=$1", [
      workspace,
    ]),
  ).rejects.toThrow(/permission denied/);
});

it.each(["anon", "authenticated", "service_role"])(
  "restricts the rollback backup and routine from %s",
  async (role) => {
    const privileges = (
      await db.query<{
        read: boolean;
        write: boolean;
        rollback: boolean;
        helper: boolean;
      }>(
        `select has_table_privilege($1,'${backup}','select') as read,
    has_table_privilege($1,'${backup}','update') as write,
    has_function_privilege($1,'private.rollback_workspace_display_names_202610120007()','execute') as rollback,
    has_function_privilege($1,'private.workspace_default_name(uuid)','execute') as helper`,
        [role],
      )
    ).rows[0];
    expect(privileges).toEqual({
      read: false,
      write: false,
      rollback: false,
      helper: false,
    });
    await db.exec(`set role ${role}`);
    await expect(db.query(`select * from ${backup}`)).rejects.toThrow(
      /permission denied/,
    );
  },
);

it("rolls back unchanged renamed rows while skipping later Settings names and new workspaces", async () => {
  await asUser(client);
  await db.query(
    "select public.save_settings('Owner changed',$1,'Later chosen name','America/New_York')",
    [workspace],
  );
  await db.exec("reset role");
  await db.query(
    "insert into auth.users(id,email,raw_user_meta_data) values($1,'later@test.com','{\"display_name\":\"Later Owner\"}')",
    [insertedOwner],
  );
  const result = (
    await db.query<{ restored: number }>(
      "select private.rollback_workspace_display_names_202610120007() as restored",
    )
  ).rows[0];
  expect(result.restored).toBe(7);
  const rows = (
    await db.query<{ owner_id: string; name: string }>(
      "select owner_id,name from public.workspaces order by owner_id",
    )
  ).rows;
  expect(rows).toEqual([
    { owner_id: client, name: "Later chosen name" },
    ...fixtures
      .slice(1)
      .map((fixture) => ({ owner_id: fixture.id, name: fixture.old })),
    { owner_id: insertedOwner, name: "Workspace - Later Owner" },
  ]);
  expect(
    (
      await db.query("select timezone from public.workspaces where id=$1", [
        workspace,
      ])
    ).rows,
  ).toEqual([{ timezone: "America/New_York" }]);
});
