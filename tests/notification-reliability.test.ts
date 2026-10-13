import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
let db: PGlite;
const client = "00000000-0000-4000-8000-000000000001";
const bidder = "00000000-0000-4000-8000-000000000003";
let workspace: string;
let repairMessage: string;
async function actor(id = client) {
  await db.exec(
    `reset role; set role authenticated; select set_config('request.jwt.claim.sub','${id}',false); select set_config('request.jwt.claim.role','authenticated',false)`,
  );
}
async function service() {
  await db.exec(
    "reset role; set role service_role; select set_config('request.jwt.claim.role','service_role',false)",
  );
}
async function save(schedule: object, extra = {}) {
  return (
    await db.query<{
      result: {
        id: string;
        status: string;
        next_at: string | null;
        send_on_publish: boolean;
      };
    }>("select public.save_notification_message($1::jsonb) result", [
      JSON.stringify({
        workspace_id: workspace,
        title: "Update",
        body: "Authored message",
        recipient_mode: "all",
        recipient_ids: [],
        schedule,
        ...extra,
      }),
    ])
  ).rows[0].result;
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
    alter table storage.objects enable row level security;
    grant usage on schema auth,storage to authenticated,service_role; grant all on storage.objects to authenticated,service_role;`);
  for (const file of readdirSync("supabase/migrations")
    .filter(
      (f) =>
        f.endsWith(".sql") && f !== "202610120013_notification_reliability.sql",
    )
    .sort())
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  await db.query(
    "insert into auth.users(id,email) values ($1,'client@test.invalid')",
    [client],
  );
  await db.exec("update public.profiles set approval_status='approved'");
  await actor();
  workspace = (
    await db.query<{ id: string }>("select id from public.workspaces")
  ).rows[0].id;
  await db.query(
    "select public.invite_bidder($1,'bidder@test.invalid','Bidder',125)",
    [workspace],
  );
  await db.exec("reset role");
  await db.query(
    "update public.invitations set id=$1 where email='bidder@test.invalid'",
    [bidder],
  );
  await db.query(
    "insert into auth.users(id,email,raw_app_meta_data) values($1::uuid,'bidder@test.invalid',jsonb_build_object('bidder_provisioning_id',$1::text))",
    [bidder],
  );
  await actor();
  repairMessage = (
    await db.query<{ id: string }>(
      "select public.save_client_message(null,$1,'Repair','Body','all','{}','daily',null,'09:00','{}') id",
      [workspace],
    )
  ).rows[0].id;
  await db.exec("reset role");
  await db.query("update public.client_messages set next_at=null where id=$1", [
    repairMessage,
  ]);
  await db.exec(
    readFileSync(
      "supabase/migrations/202610120013_notification_reliability.sql",
      "utf8",
    ),
  );
}, 30000);
afterAll(async () => {
  await db?.close();
});

it("forward migration repairs active recurring null next_at to a future slot", async () => {
  await actor();
  expect(
    (
      await db.query<{ future: boolean }>(
        "select next_at>clock_timestamp() future from public.client_messages where id=$1",
        [repairMessage],
      )
    ).rows[0].future,
  ).toBe(true);
});

it("resuming a paused edited recurring message chooses a future slot", async () => {
  await actor();
  const id = (
    await db.query<{ id: string }>(
      "select public.save_client_message(null,$1,'Daily','Body','all','{}','daily',null,'09:00','{}',false) id",
      [workspace],
    )
  ).rows[0].id;
  await db.query("select public.set_message_status($1,'paused')", [id]);
  await db.query(
    "select public.save_client_message($1,$2,'Daily','Edited','all','{}','daily',null,'10:00','{}',false)",
    [id, workspace],
  );
  await db.query("select public.set_message_status($1,'active')", [id]);
  expect(
    (
      await db.query<{ future: boolean }>(
        "select next_at>clock_timestamp() future from public.client_messages where id=$1",
        [id],
      )
    ).rows[0].future,
  ).toBe(true);
});
it("rejects stale completion including a stale 410 after a successful lease", async () => {
  await actor();
  await db.query(
    "select public.save_client_message(null,$1,'Now','Body','all','{}','once',clock_timestamp(),null,'{}')",
    [workspace],
  );
  await actor(bidder);
  const sub = (
    await db.query<{ id: string }>(
      "select public.save_push_subscription('https://push.test.invalid/one','key','auth') id",
    )
  ).rows[0].id;
  await service();
  await db.query(
    "select public.process_due_messages(clock_timestamp()+interval '1 second',100)",
  );
  await db.query("select public.queue_notification_pushes()");
  const a = (
    await db.query<{ attempt_id: string; lease_id: string }>(
      "select * from public.claim_push_attempts(5)",
    )
  ).rows[0];
  await db.query("select public.finish_push_attempt($1,$2,null,false)", [
    a.attempt_id,
    a.lease_id,
  ]);
  await db.query("select public.finish_push_attempt($1,$2,'Gone',true)", [
    a.attempt_id,
    a.lease_id,
  ]);
  expect(
    (
      await db.query("select id from public.push_subscriptions where id=$1", [
        sub,
      ])
    ).rows,
  ).toHaveLength(1);
  await db.query("select public.finish_push_attempt($1,null,'Retry',false)", [
    a.attempt_id,
  ]);
  expect(
    (
      await db.query<{ last_error: string | null }>(
        "select last_error from public.push_attempts where id=$1",
        [a.attempt_id],
      )
    ).rows[0].last_error,
  ).toBeNull();
});
it("persists immediate draft intent and publishes without an obsolete date", async () => {
  await actor();
  const m = await save({ kind: "now" }, { draft: true });
  expect(m).toMatchObject({
    status: "draft",
    next_at: null,
    send_on_publish: true,
  });
  await db.query("select public.set_message_status($1,'active')", [m.id]);
  expect(
    (
      await db.query<{ queued: boolean }>(
        "select status='scheduled' and next_at is not null queued from public.client_messages where id=$1",
        [m.id],
      )
    ).rows[0].queued,
  ).toBe(true);
});
it("uses one resolver for spring gaps, first fall-back and future once validation", async () => {
  await actor();
  await expect(
    db.query(
      "select public.resolve_notification_schedule($1::jsonb,'2026-01-01',true)",
      [JSON.stringify({ kind: "once", scheduled_local: "2026-03-08T02:30" })],
    ),
  ).rejects.toThrow(/does not exist/);
  const resolve = async (s: object, after: string) =>
    (
      await db.query<{ stamp: string }>(
        "select to_char(public.resolve_notification_schedule($1::jsonb,$2,true) at time zone 'UTC','YYYY-MM-DD HH24:MI') stamp",
        [JSON.stringify(s), after],
      )
    ).rows[0].stamp;
  expect(
    await resolve(
      { kind: "daily", local_time: "02:30" },
      "2026-03-08T06:00:00Z",
    ),
  ).toBe("2026-03-08 08:30");
  expect(
    await resolve(
      { kind: "once", scheduled_local: "2026-11-01T01:30" },
      "2026-11-01T05:00:00Z",
    ),
  ).toBe("2026-11-01 06:30");
  expect(
    await resolve(
      { kind: "daily", local_time: "01:30" },
      "2026-11-01T06:45:00Z",
    ),
  ).toBe("2026-11-02 07:30");
  await expect(
    save({ kind: "once", scheduled_local: "2020-01-01T09:00" }),
  ).rejects.toThrow(/future/);
});
it("rejects recipients outside the chosen workspace", async () => {
  await actor();
  await expect(
    save(
      { kind: "now" },
      { recipient_mode: "selected", recipient_ids: [client] },
    ),
  ).rejects.toThrow(/active.*workspace/);
});
it("paginates tied timestamps without losing rows and authorizes deep links", async () => {
  await service();
  const m = (
    await db.query<{ id: string }>(
      "select id from public.client_messages limit 1",
    )
  ).rows[0].id;
  await db.query(
    "insert into public.message_occurrences(message_id,scheduled_for) select $1, '2040-01-01'::timestamptz+g*interval '1 day' from generate_series(1,120) g",
    [m],
  );
  await db.query(
    "insert into public.inbox_notifications(occurrence_id,user_id,title,body,created_at) select id,$1,'Paged','Body','2040-01-01' from public.message_occurrences where message_id=$2 on conflict do nothing",
    [bidder, m],
  );
  await actor(bidder);
  type Page = {
    rows: { id: string }[];
    next_cursor: object | null;
    unread_count: number;
  };
  const page = async (cursor: object | null = null) =>
    (
      await db.query<{ result: Page }>(
        "select public.notification_page('inbox',null,null,$1::jsonb) result",
        [cursor ? JSON.stringify(cursor) : null],
      )
    ).rows[0].result;
  const first = await page();
  const second = await page(first.next_cursor);
  const third = await page(second.next_cursor);
  expect(first.rows).toHaveLength(50);
  expect(second.rows).toHaveLength(50);
  expect(first.unread_count).toBeGreaterThanOrEqual(120);
  expect(
    new Set([...first.rows, ...second.rows, ...third.rows].map((r) => r.id))
      .size,
  ).toBe(first.rows.length + second.rows.length + third.rows.length);
  const deep = third.rows[0].id;
  expect(
    (
      await db.query<{ r: { id: string } }>(
        "select public.notification_by_id($1) r",
        [deep],
      )
    ).rows[0].r.id,
  ).toBe(deep);
  await actor();
  await expect(
    db.query("select public.notification_by_id($1)", [deep]),
  ).rejects.toThrow(/not found/);
});

it("enqueues 500 missing pairs per pass and sees a later committed older notification", async () => {
  await actor(bidder);
  const sub = (
    await db.query<{ id: string }>(
      "select public.save_push_subscription('https://push.test.invalid/bounded','key','auth') id",
    )
  ).rows[0].id;
  await service();
  await db.query(
    "update public.push_subscriptions set created_at='2030-01-01' where id=$1",
    [sub],
  );
  const m = (
    await db.query<{ id: string }>(
      "select id from public.client_messages limit 1",
    )
  ).rows[0].id;
  await db.query(
    "insert into public.message_occurrences(message_id,scheduled_for) select $1, '2050-01-01'::timestamptz+g*interval '1 day' from generate_series(1,600) g",
    [m],
  );
  await db.query(
    "insert into public.inbox_notifications(occurrence_id,user_id,title,body,created_at) select id,$1,'Queue','Body','2050-01-01' from public.message_occurrences where message_id=$2 on conflict do nothing",
    [bidder, m],
  );
  const enqueue = async () =>
    (
      await db.query<{ n: number }>(
        "select public.queue_notification_pushes() n",
      )
    ).rows[0].n;
  expect(await enqueue()).toBe(500);
  expect(await enqueue()).toBe(500);
  expect(await enqueue()).toBeGreaterThan(0);
  expect(await enqueue()).toBe(0);
  await db.query(
    "insert into public.message_occurrences(message_id,scheduled_for) values($1,'2031-01-01')",
    [m],
  );
  await db.query(
    "insert into public.inbox_notifications(occurrence_id,user_id,title,body,created_at) select id,$1,'Late commit','Body','2031-01-01' from public.message_occurrences where message_id=$2 and scheduled_for='2031-01-01'",
    [bidder, m],
  );
  expect(await enqueue()).toBe(2);
  await db.query(
    "update public.push_subscriptions set created_at='2099-01-01' where id=$1",
    [sub],
  );
  const claimed = (
    await db.query<{ attempt_id: string }>(
      "select * from public.claim_push_attempts(100)",
    )
  ).rows;
  expect(claimed.length).toBeLessThanOrEqual(5);
  const deviceAttempts = (
    await db.query<{ id: string }>(
      "select id from public.push_attempts where subscription_id=$1",
      [sub],
    )
  ).rows.map((r) => r.id);
  expect(claimed.some((a) => deviceAttempts.includes(a.attempt_id))).toBe(
    false,
  );
  const second = (
    await db.query<{ attempt_id: string }>(
      "select * from public.claim_push_attempts(5)",
    )
  ).rows;
  expect(
    second.some((a) => claimed.some((b) => a.attempt_id === b.attempt_id)),
  ).toBe(false);
});
it("recurring outage recovery publishes latest due only and never duplicates an occurrence", async () => {
  await actor();
  const m = await save({ kind: "daily", local_time: "09:00" });
  await service();
  await db.query(
    "update public.client_messages set next_at='2030-01-01T15:00:00Z' where id=$1",
    [m.id],
  );
  await db.query(
    "select public.process_due_messages('2030-01-10T18:00:00Z',100)",
  );
  await db.query(
    "select public.process_due_messages('2030-01-10T18:00:00Z',100)",
  );
  expect(
    (
      await db.query<{ stamp: string }>(
        "select to_char(scheduled_for at time zone 'UTC','YYYY-MM-DD HH24:MI') stamp from public.message_occurrences where message_id=$1",
        [m.id],
      )
    ).rows,
  ).toEqual([{ stamp: "2030-01-10 15:00" }]);
});
it("expired one-off resume requires editing or explicit immediate intent", async () => {
  await actor();
  const m = await save({ kind: "once", scheduled_local: "2090-01-01T09:00" });
  await db.query("select public.set_message_status($1,'paused')", [m.id]);
  await service();
  await db.query(
    "update public.client_messages set scheduled_at='2020-01-01' where id=$1",
    [m.id],
  );
  await actor();
  await expect(
    db.query("select public.set_message_status($1,'active')", [m.id]),
  ).rejects.toThrow(/future/);
  const edited = await save({ kind: "now" }, { id: m.id });
  expect(edited.status).toBe("paused");
  await db.query("select public.set_message_status($1,'active')", [m.id]);
});

it("does not publish to a bidder after the workspace owner loses approval", async () => {
  await actor();
  const m = await save({ kind: "now" });
  await service();
  await db.query(
    "update public.profiles set approval_status='pending' where id=$1",
    [client],
  );
  await db.query(
    "select public.process_due_messages(clock_timestamp()+interval '1 second',100)",
  );
  const inbox = await db.query(
    "select n.id from public.inbox_notifications n join public.message_occurrences o on o.id=n.occurrence_id where o.message_id=$1",
    [m.id],
  );
  await db.query(
    "update public.profiles set approval_status='approved' where id=$1",
    [client],
  );
  expect(inbox.rows).toHaveLength(0);
});
