import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

let db: PGlite;
const admin = "32000000-0000-4000-8000-000000000001";
const owner = "32000000-0000-4000-8000-000000000002";
const outsider = "32000000-0000-4000-8000-000000000003";
const bidder = "32000000-0000-4000-8000-000000000004";
const otherBidder = "32000000-0000-4000-8000-000000000005";
const commitment = "a".repeat(64);
async function actor(id = owner, role = "authenticated", session?: string) {
  await db.exec(`reset role; set role ${role}`);
  await db.query(
    "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false),set_config('request.jwt.claims',$3,false)",
    [
      id,
      role,
      JSON.stringify({
        sub: id,
        role,
        ...(session ? { session_id: session } : {}),
      }),
    ],
  );
}
async function call(name: string, args: unknown[] = []) {
  return (
    await db.query<{ result: Record<string, unknown> }>(
      `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) result`,
      args,
    )
  ).rows[0].result;
}
async function sessions(id: string) {
  await db.exec("reset role");
  return (
    await db.query<{ id: string }>(
      "select id from auth.sessions where user_id=$1",
      [id],
    )
  ).rows.map((r) => r.id);
}
async function addSession(id: string) {
  await db.exec("reset role");
  const session = randomUUID();
  await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [
    session,
    id,
  ]);
  await db.query(
    "insert into auth.refresh_tokens(user_id,session_id) values($1,$2)",
    [id, session],
  );
  return session;
}
async function begin(
  kind: string,
  target = bidder,
  request = randomUUID(),
  extra = {},
) {
  return call("begin_account_operation", [request, kind, { target, ...extra }]);
}
async function accepted(op: Record<string, unknown>) {
  await db.exec("reset role");
  await db.query(
    "update auth.users set encrypted_password='changed',raw_app_meta_data=jsonb_build_object('managed_account_operation',$2::jsonb) where id=$1",
    [op.targetId, { request: op.requestId, dispatch: op.dispatchId }],
  );
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create role authenticator;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',email_confirmed_at timestamptz,encrypted_password text);
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id));
    create table auth.refresh_tokens(id bigserial primary key,user_id text,session_id uuid references auth.sessions(id) on delete cascade);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
    alter table storage.objects enable row level security;
    grant usage on schema auth,storage to authenticated,service_role;
    grant all on storage.objects to authenticated,service_role;`);
  for (const file of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  await db.query(
    "insert into auth.users(id,email) values($1,'security-admin@example.test'),($2,'security-owner@example.test'),($3,'security-outsider@example.test')",
    [admin, owner, outsider],
  );
  await db.exec("update public.profiles set approval_status='approved'");
  await db.query("update public.profiles set role='admin' where id=$1", [
    admin,
  ]);
  const workspace = (
    await db.query<{ id: string }>(
      "select id from public.workspaces where owner_id=$1",
      [owner],
    )
  ).rows[0].id;
  for (const [id, email] of [
    [bidder, "security-bidder@example.test"],
    [otherBidder, "security-other@example.test"],
  ]) {
    await db.query(
      "insert into public.invitations(id,workspace_id,email,display_name) values($1,$2,$3,'Security bidder')",
      [id, workspace, email],
    );
    await db.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
      [id, email],
    );
  }
}, 60000);
afterAll(async () => {
  await db?.close();
});

it("owner sign-out revokes only bidder sessions and replay preserves a later login", async () => {
  await addSession(bidder);
  await addSession(bidder);
  const ownerSession = await addSession(owner),
    otherSession = await addSession(otherBidder);
  await actor();
  const op = await begin("sign_out_bidder");
  expect((await call("finish_account_operation", [op.requestId])).status).toBe(
    "completed",
  );
  expect(await sessions(bidder)).toEqual([]);
  expect(await sessions(owner)).toContain(ownerSession);
  expect(await sessions(otherBidder)).toContain(otherSession);
  const later = await addSession(bidder);
  await actor();
  await call("finish_account_operation", [op.requestId]);
  expect(await sessions(bidder)).toEqual([later]);
  const events = await db.query(
    "select * from public.account_events where account_id=$1 and event='signed_out'",
    [bidder],
  );
  expect(events.rows).toHaveLength(1);
  expect(
    (
      await db.query("select * from auth.refresh_tokens where user_id=$1", [
        bidder,
      ])
    ).rows,
  ).toHaveLength(1);
});
it("rejects unrelated, bidder, inactive and unapproved actors before revocation", async () => {
  const session = await addSession(bidder);
  for (const id of [outsider, bidder]) {
    await actor(id);
    await expect(begin("sign_out_bidder")).rejects.toThrow(/denied/i);
  }
  for (const patch of [
    "archived=true",
    "archived=false,approval_status='pending'",
  ]) {
    await db.exec("reset role");
    await db.query(`update public.profiles set ${patch} where id=$1`, [owner]);
    await actor();
    await expect(begin("sign_out_bidder")).rejects.toThrow(/denied/i);
  }
  await db.exec("reset role");
  await db.query(
    "update public.profiles set archived=false,approval_status='approved' where id=$1",
    [owner],
  );
  expect(await sessions(bidder)).toContain(session);
});
it("admin may sign out a bidder but clients and admins are invalid targets", async () => {
  await actor(admin);
  const op = await begin("sign_out_bidder");
  await call("finish_account_operation", [op.requestId]);
  for (const target of [owner, admin])
    await expect(begin("sign_out_bidder", target)).rejects.toThrow(
      /denied|bidder/i,
    );
});
it("live-session enforcement rejects stale, missing, malformed and foreign session claims", async () => {
  const session = await addSession(bidder);
  await actor(bidder, "authenticated", session);
  expect(await call("has_live_session")).toBe(true);
  await call("enforce_live_session");
  for (const value of [undefined, "malformed", randomUUID()]) {
    await actor(bidder, "authenticated", value);
    await expect(call("enforce_live_session")).rejects.toMatchObject({
      code: "PT401",
    });
  }
  await actor(otherBidder, "authenticated", session);
  await expect(call("enforce_live_session")).rejects.toMatchObject({
    code: "PT401",
  });
  await actor(admin, "service_role");
  await call("enforce_live_session");
  await actor(admin, "anon");
  await call("enforce_live_session");
});
it("password receipt revokes sessions atomically and recovery never revokes a later login", async () => {
  await addSession(bidder);
  await addSession(bidder);
  await actor();
  const op = await begin("set_bidder_password", bidder, randomUUID(), {
    password_commitment: commitment,
  });
  expect(JSON.stringify(op)).not.toContain(commitment);
  await actor(owner, "service_role");
  const dispatch = await call("dispatch_account_operation", [
    op.requestId,
    owner,
    commitment,
  ]);
  await accepted(dispatch);
  expect(await sessions(bidder)).toEqual([]);
  const later = await addSession(bidder);
  await actor();
  await call("finish_account_operation", [op.requestId]);
  expect(await sessions(bidder)).toEqual([later]);
});
it("binds password commitment to request identity and requires it for dispatch", async () => {
  await actor();
  const request = randomUUID();
  const op = await begin("set_bidder_password", bidder, request, {
    password_commitment: commitment,
  });
  await expect(
    begin("set_bidder_password", bidder, request, {
      password_commitment: "b".repeat(64),
    }),
  ).rejects.toThrow(/different content/);
  await actor(owner, "service_role");
  await expect(
    call("dispatch_account_operation", [op.requestId, owner]),
  ).rejects.toThrow(/password/i);
  await actor();
  await call("abandon_account_operation", [op.requestId]).catch(async () => {
    await actor(admin);
    await call("abandon_account_operation", [op.requestId]);
  });
});
it("rejects newly requested legacy fixed bidder password resets", async () => {
  await actor();
  await expect(begin("reset_password")).rejects.toThrow(/password/i);
});
it("registers the Data API hook and keeps Storage blocked for a revoked session", async () => {
  await db.exec("reset role");
  const role = (
    await db.query<{ rolconfig: string[] }>(
      "select rolconfig from pg_roles where rolname='authenticator'",
    )
  ).rows[0];
  expect(role.rolconfig).toContain(
    "pgrst.db_pre_request=public.enforce_live_session",
  );
  await db.exec(
    "create policy session_probe on storage.objects for all to authenticated using (bucket_id='session-probe') with check (bucket_id='session-probe'); insert into storage.objects(bucket_id,name) values('session-probe','probe')",
  );
  const session = await addSession(bidder);
  await actor(bidder, "authenticated", session);
  expect(
    (
      await db.query(
        "select name from storage.objects where bucket_id='session-probe'",
      )
    ).rows,
  ).toEqual([{ name: "probe" }]);
  await db.exec("reset role");
  await db.query("delete from auth.sessions where id=$1", [session]);
  await actor(bidder, "authenticated", session);
  expect(
    (
      await db.query(
        "select name from storage.objects where bucket_id='session-probe'",
      )
    ).rows,
  ).toEqual([]);
  await expect(
    db.exec(
      "insert into storage.objects(bucket_id,name) values('session-probe','blocked')",
    ),
  ).rejects.toThrow(/row.level security/i);
  await db.exec("reset role; drop policy session_probe on storage.objects");
});
it("rolls back the password effect and preserves sessions if the manager loses access", async () => {
  const session = await addSession(bidder);
  await actor();
  const op = await begin("set_bidder_password", bidder, randomUUID(), {
    password_commitment: commitment,
  });
  await actor(owner, "service_role");
  const sent = await call("dispatch_account_operation", [
    op.requestId,
    owner,
    commitment,
  ]);
  await db.exec("reset role");
  await db.query("update public.profiles set archived=true where id=$1", [
    owner,
  ]);
  await expect(accepted(sent)).rejects.toThrow(/denied/i);
  expect(await sessions(bidder)).toContain(session);
  await db.query("update public.profiles set archived=false where id=$1", [
    owner,
  ]);
  await actor(admin);
  await call("abandon_account_operation", [op.requestId]);
});
it("fences a late custom-password dispatch before allowing a new credential effect", async () => {
  const session = await addSession(bidder);
  await actor();
  const op = await begin("set_bidder_password", bidder, randomUUID(), {
    password_commitment: commitment,
  });
  await actor(owner, "service_role");
  const old = await call("dispatch_account_operation", [
    op.requestId,
    owner,
    commitment,
  ]);
  await db.exec("reset role");
  await db.query(
    "update public.account_operations set lease_until=now()-interval '1 second' where request_id=$1",
    [op.requestId],
  );
  await actor();
  await call("reconcile_account_operation", [op.requestId]);
  await expect(accepted(old)).rejects.toThrow(/fenced/i);
  expect(await sessions(bidder)).toContain(session);
  await actor(owner, "service_role");
  const fresh = await call("dispatch_account_operation", [
    op.requestId,
    owner,
    commitment,
  ]);
  await accepted(fresh);
  expect(await sessions(bidder)).toEqual([]);
  await actor();
  await call("finish_account_operation", [op.requestId]);
});
