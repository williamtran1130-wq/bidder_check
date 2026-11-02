import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
let db: PGlite;
const admin = "22000000-0000-4000-8000-000000000001";
const owner = "22000000-0000-4000-8000-000000000002";
const outsider = "22000000-0000-4000-8000-000000000003";
let workspace: string;
async function actor(id = admin, role = "authenticated") {
  await db.exec(`reset role; set role ${role}`);
  await db.query(
    "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false)",
    [id, role],
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
const payload = (extra = {}) => ({
  name: "New client",
  email: "durable@example.test",
  ...extra,
});
async function begin(
  kind = "create_client",
  intent: Record<string, unknown> = payload(),
  request: string = randomUUID(),
) {
  await actor();
  return call("begin_account_operation", [request, kind, intent]);
}
async function dispatch(request: unknown, who = admin) {
  await actor(who, "service_role");
  return call("dispatch_account_operation", [request, who]);
}
async function accept(op: Record<string, unknown>, create = true) {
  await db.exec("reset role");
  const marker = { request: op.requestId, dispatch: op.dispatchId };
  if (create)
    await db.query(
      "insert into auth.users(id,email,raw_app_meta_data,email_confirmed_at) values($1,$2,jsonb_build_object('managed_account_operation',$3::jsonb),now())",
      [op.targetId, (op.payload as { email: string }).email, marker],
    );
  else
    await db.query(
      "update auth.users set raw_app_meta_data=jsonb_build_object('managed_account_operation',$2::jsonb) where id=$1",
      [op.targetId, marker],
    );
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth; create schema storage;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',email_confirmed_at timestamptz,encrypted_password text);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
 alter table storage.objects enable row level security;
 grant usage on schema auth,storage to authenticated,service_role;
 grant all on storage.objects to authenticated,service_role;`);
  for (const file of readdirSync("supabase/migrations")
    .filter((x) => x.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  await db.query(
    "insert into auth.users(id,email) values($1,'admin@example.test'),($2,'owner@example.test'),($3,'outsider@example.test')",
    [admin, owner, outsider],
  );
  await db.exec("update public.profiles set approval_status='approved'");
  await db.query("update public.profiles set role='admin' where id=$1", [
    admin,
  ]);
  workspace = (
    await db.query<{ id: string }>(
      "select id from public.workspaces where owner_id=$1",
      [owner],
    )
  ).rows[0].id;
}, 60000);
afterAll(async () => {
  await db?.close();
});
it("exposes durable account completion without granting clients provider acceptance", async () => {
  const funcs = (
    await db.query<{ name: string }>(
      "select proname name from pg_proc where proname='begin_account_operation'",
    )
  ).rows;
  expect(funcs).toEqual([{ name: "begin_account_operation" }]);
  await actor();
  await expect(
    call("dispatch_account_operation", [randomUUID(), admin]),
  ).rejects.toMatchObject({ code: "42501" });
});
it("binds normalized request identity and commits creation audit once after a lost successful SQL response", async () => {
  const op = await begin();
  const repeated = await begin(
    "create_client",
    payload({ email: " DURABLE@EXAMPLE.TEST " }),
    op.requestId as string,
  );
  expect(repeated.targetId).toBe(op.targetId);
  await expect(
    begin("create_client", payload({ name: "Other" }), op.requestId as string),
  ).rejects.toThrow(/different content/);
  const sent = await dispatch(op.requestId);
  await accept(sent);
  await actor();
  expect((await call("finish_account_operation", [op.requestId])).status).toBe(
    "completed",
  );
  expect((await call("finish_account_operation", [op.requestId])).status).toBe(
    "completed",
  );
  await db.exec("reset role");
  expect(
    (
      await db.query<{ event: string }>(
        "select event from public.account_events where account_id=$1 order by event",
        [op.targetId],
      )
    ).rows,
  ).toEqual([{ event: "approved" }, { event: "created" }]);
});
it("fences an unobserved dispatch before retry and rejects a late password effect atomically", async () => {
  const op = await begin("reset_password", { target: owner });
  const sent = await dispatch(op.requestId);
  const duplicate = await dispatch(op.requestId);
  expect(duplicate.dispatchId).toBeUndefined();
  expect(duplicate.status).toBe("pending");
  await db.exec("reset role");
  await db.query(
    "update public.account_operations set lease_until=now()-interval '1 second' where request_id=$1",
    [op.requestId],
  );
  await actor();
  expect(
    (await call("reconcile_account_operation", [op.requestId])).status,
  ).toBe("ready");
  await db.exec("reset role; begin");
  await db.query(
    "update auth.users set encrypted_password='late-test-hash' where id=$1",
    [owner],
  );
  await expect(accept(sent, false)).rejects.toThrow(/dispatch|fenced/i);
  await db.exec("rollback; reset role");
  expect(
    (
      await db.query<{ encrypted_password: null }>(
        "select encrypted_password from auth.users where id=$1",
        [owner],
      )
    ).rows[0].encrypted_password,
  ).toBeNull();
  const current = await dispatch(op.requestId);
  expect(current.dispatchId).not.toBe(sent.dispatchId);
  await accept(current, false);
  await actor();
  expect((await call("finish_account_operation", [op.requestId])).status).toBe(
    "completed",
  );
});
it("keeps conflicts blocked on lease expiry and blocks legacy mutations until disposition", async () => {
  const op = await begin("update_client", {
    target: owner,
    name: "Owner updated",
    email: "owner@example.test",
    archived: false,
  });
  await expect(begin("reset_password", { target: owner })).rejects.toThrow(
    /pending account operation/i,
  );
  await expect(
    call("update_client", [owner, "Conflicting", false]),
  ).rejects.toThrow(/pending account operation/i);
  expect((await dispatch(op.requestId)).authStep).toBe("skipped");
  await actor();
  await call("finish_account_operation", [op.requestId]);
});
it("authorizes exact bidder reservation before a profile exists, then checks revoked managers", async () => {
  await actor(owner);
  const request = randomUUID();
  const op = await call("begin_account_operation", [
    request,
    "create_bidder",
    { workspace, email: "newbidder@example.test", name: "Bidder", rate: 12 },
  ]);
  expect(op.targetId).toBeTruthy();
  const sent = await dispatch(request, owner);
  await db.exec("reset role");
  await db.query("update public.profiles set archived=true where id=$1", [
    owner,
  ]);
  await expect(accept(sent)).rejects.toThrow(
    /Access denied|Workspace is inactive/,
  );
  await actor(outsider);
  await expect(call("account_operation_status", [request])).rejects.toThrow(
    /Access denied/,
  );
  await actor();
  const released = await call("abandon_account_operation", [request]);
  expect(released.status).toBe("abandoned");
  await db.exec("reset role");
  await db.query("update public.profiles set archived=false where id=$1", [
    owner,
  ]);
});
it("accepts provider email-before-marker ordering, preserves the sync trigger, and ignores retained markers", async () => {
  const op = await begin("update_client", {
    target: owner,
    name: "Owner",
    email: "renamed@example.test",
    archived: false,
  });
  const sent = await dispatch(op.requestId);
  await db.exec("reset role; begin");
  await db.query(
    "update auth.users set email='renamed@example.test' where id=$1",
    [owner],
  );
  await accept(sent, false);
  await db.exec("commit");
  expect(
    (
      await db.query<{ email: string }>(
        "select email from public.profiles where id=$1",
        [owner],
      )
    ).rows[0].email,
  ).toBe("renamed@example.test");
  await actor();
  await call("finish_account_operation", [op.requestId]);
  await db.exec("reset role");
  await db.query(
    "update auth.users set raw_app_meta_data=raw_app_meta_data||'{\"unrelated\":true}',encrypted_password='self-service' where id=$1",
    [owner],
  );
  await db.query(
    "update auth.users set email='owner@example.test' where id=$1",
    [owner],
  );
  expect(
    (
      await db.query<{ email: string }>(
        "select email from public.profiles where id=$1",
        [owner],
      )
    ).rows[0].email,
  ).toBe("owner@example.test");
});
it("rolls back metadata, audit and completion together when SQL fails after Auth acceptance", async () => {
  const op = await begin("update_client", {
    target: owner,
    name: "Atomic",
    email: "owner@example.test",
    archived: false,
  });
  await db.exec("reset role");
  await db.exec(
    "create function public.fail_account_audit_test() returns trigger language plpgsql as $$begin raise exception 'injected audit failure';end$$; create trigger fail_account_audit_test before insert on public.account_events for each row execute function public.fail_account_audit_test()",
  );
  await actor();
  await expect(
    call("finish_account_operation", [op.requestId]),
  ).rejects.toThrow(/injected audit failure/);
  expect((await call("account_operation_status", [op.requestId])).status).toBe(
    "ready",
  );
  await db.exec(
    "reset role; drop trigger fail_account_audit_test on public.account_events; drop function public.fail_account_audit_test()",
  );
  expect(
    (
      await db.query<{ display_name: string }>(
        "select display_name from public.profiles where id=$1",
        [owner],
      )
    ).rows[0].display_name,
  ).not.toBe("Atomic");
  await actor();
  expect((await call("finish_account_operation", [op.requestId])).status).toBe(
    "completed",
  );
});

it("accepts provider creation insert then metadata then confirmation in one transaction", async () => {
  await actor(owner);
  const request = randomUUID();
  const op = await call("begin_account_operation", [
    request,
    "create_bidder",
    {
      workspace,
      email: "orderedbidder@example.test",
      name: "A very long bidder name ".repeat(7),
      rate: null,
    },
  ]);
  const sent = await dispatch(request, owner);
  await db.exec("reset role; begin");
  await db.query(
    "insert into auth.users(id,email) values($1,'orderedbidder@example.test')",
    [op.targetId],
  );
  await accept(sent, false);
  await db.query("update auth.users set email_confirmed_at=now() where id=$1", [
    op.targetId,
  ]);
  await db.exec("commit");
  await actor(owner);
  expect((await call("finish_account_operation", [request])).status).toBe(
    "completed",
  );
  await db.exec("reset role");
  expect(
    (
      await db.query<{ display_name: string }>(
        "select display_name from public.profiles where id=$1",
        [op.targetId],
      )
    ).rows[0].display_name.length,
  ).toBeGreaterThan(100);
});
it("rolls back a tentative provider receipt if the Auth transaction fails later", async () => {
  const op = await begin("reset_password", { target: owner });
  const sent = await dispatch(op.requestId);
  await db.exec("reset role; begin");
  await accept(sent, false);
  await db.exec("rollback");
  await actor();
  expect(
    (await call("account_operation_status", [op.requestId])).authStep,
  ).toBe("dispatched");
  await call("abandon_account_operation", [op.requestId]);
});
it("records accepted effects and administrator abandonment once with original actor attribution", async () => {
  const op = await begin("reset_password", { target: owner });
  const sent = await dispatch(op.requestId);
  await accept(sent, false);
  await actor();
  await call("abandon_account_operation", [op.requestId]);
  await call("abandon_account_operation", [op.requestId]);
  await db.exec("reset role");
  const rows = (
    await db.query<{ event: string; actor_id: string }>(
      "select event,actor_id from public.account_events where reason like '%'||$1||'%' order by event",
      [op.requestId],
    )
  ).rows;
  expect(rows).toEqual([
    { event: "operation_abandoned", actor_id: admin },
    { event: "password_reset", actor_id: admin },
  ]);
});
it("rejects an invalid rate before reserving or dispatching Auth", async () => {
  await actor(owner);
  await expect(
    call("begin_account_operation", [
      randomUUID(),
      "create_bidder",
      {
        workspace,
        email: "invalidrate@example.test",
        name: "Invalid",
        rate: 100000001,
      },
    ]),
  ).rejects.toThrow(/Rate is invalid|default_rate/);
  await db.exec("reset role");
  expect(
    (
      await db.query(
        "select id from public.invitations where email='invalidrate@example.test'",
      )
    ).rows,
  ).toEqual([]);
});
it("rejects an invalid edit rate before an email effect can be dispatched", async () => {
  await db.exec("reset role");
  const target = (
    await db.query<{ id: string }>(
      "select id from public.profiles where email='orderedbidder@example.test'",
    )
  ).rows[0].id;
  await actor(owner);
  await expect(
    call("begin_account_operation", [
      randomUUID(),
      "update_bidder",
      {
        target,
        email: "rate-edit@example.test",
        name: "Invalid edit",
        archived: false,
        rate: 100000001,
      },
    ]),
  ).rejects.toThrow(/Rate is invalid/);
});
async function reviewBidder(email: string) {
  await actor(owner);
  const id = (
    await db.query<{ id: string }>(
      "select public.invite_bidder($1,$2,'Review bidder',25) id",
      [workspace, email],
    )
  ).rows[0].id;
  await db.exec("reset role");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
    [id, email],
  );
  return id;
}
it("rejects outsider and administrator emails before an owner intent can lock unrelated account edits", async () => {
  const target = await reviewBidder("review-owned@example.test");
  for (const email of ["outsider@example.test", "admin@example.test"]) {
    const request = randomUUID();
    await actor(owner);
    try {
      await expect(
        call("begin_account_operation", [
          request,
          "update_bidder",
          { target, name: "Review bidder", email, rate: 25, archived: false },
        ]),
      ).rejects.toThrow(/already in use or reserved/);
      await db.exec("reset role");
      expect(
        (
          await db.query(
            "select request_id from public.account_operations where request_id=$1",
            [request],
          )
        ).rows,
      ).toEqual([]);
      await actor();
      if (email.startsWith("outsider"))
        await call("update_client", [outsider, "Still editable", false]);
      else
        await call("save_settings", [
          "Still editable administrator",
          null,
          "",
          "America/Chicago",
        ]);
    } finally {
      await db.exec("reset role");
      const exists = (
        await db.query(
          "select request_id from public.account_operations where request_id=$1",
          [request],
        )
      ).rows.length;
      if (exists) {
        await actor();
        await call("abandon_account_operation", [request]);
      }
    }
  }
});
it("ignores unfingerprinted reset email fields and preserves own unchanged email intents", async () => {
  const bidderTarget = await reviewBidder("review-reset@example.test");
  const target = owner;
  await actor();
  const request = randomUUID();
  const op = await call("begin_account_operation", [
    request,
    "reset_password",
    { target, email: "outsider@example.test" },
  ]);
  try {
    await db.exec("reset role");
    const journal = (
      await db.query<{ email: string | null; payload: unknown }>(
        "select email,payload from public.account_operations where request_id=$1",
        [request],
      )
    ).rows[0];
    expect(journal).toEqual({ email: null, payload: { target } });
    await actor();
    await call("update_client", [outsider, "Unaffected by reset", false]);
  } finally {
    await actor();
    await call("abandon_account_operation", [op.requestId]);
  }
  await actor(owner);
  const own = await call("begin_account_operation", [
    randomUUID(),
    "update_bidder",
    {
      target: bidderTarget,
      name: "Same email",
      email: " REVIEW-RESET@EXAMPLE.TEST ",
      rate: 25,
      archived: false,
    },
  ]);
  expect(own.authStep).toBe("skipped");
  await call("finish_account_operation", [own.requestId]);
});
it("protects existing foreign reservations and a newly reserved destination without disclosing their identity", async () => {
  const target = await reviewBidder("review-reservations@example.test");
  await actor();
  await call("reserve_client_account", [
    "reserved-client@example.test",
    "Reserved client",
  ]);
  await db.exec("reset role");
  const otherWorkspace = (
    await db.query<{ id: string }>(
      "select id from public.workspaces where owner_id=$1",
      [outsider],
    )
  ).rows[0].id;
  await actor(outsider);
  await call("invite_bidder", [
    otherWorkspace,
    "reserved-bidder@example.test",
    "Reserved bidder",
    null,
  ]);
  for (const email of [
    "reserved-client@example.test",
    "reserved-bidder@example.test",
  ]) {
    const request = randomUUID();
    await actor(owner);
    await expect(
      call("begin_account_operation", [
        request,
        "update_bidder",
        { target, name: "Review", email, rate: 25, archived: false },
      ]),
    ).rejects.toThrow(/^This email is already in use or reserved$/);
    expect(await call("account_operation_request_exists", [request])).toBe(
      false,
    );
  }
  await actor(owner);
  for (const email of [
    "reserved-client@example.test",
    "unused-private@example.test",
  ]) {
    await expect(
      call("begin_account_operation", [
        randomUUID(),
        "update_client",
        { target: outsider, name: "Forbidden", email, archived: false },
      ]),
    ).rejects.toThrow(/^Access denied$/);
  }
  const available = await call("begin_account_operation", [
    randomUUID(),
    "update_bidder",
    {
      target,
      name: "Review",
      email: "available-destination@example.test",
      rate: 25,
      archived: false,
    },
  ]);
  try {
    await actor(outsider);
    await expect(
      call("invite_bidder", [
        otherWorkspace,
        "available-destination@example.test",
        "Competing",
        null,
      ]),
    ).rejects.toThrow(/pending account operation/);
    await db.exec("reset role");
    await expect(
      db.query(
        "update auth.users set email='available-destination@example.test' where id=$1",
        [outsider],
      ),
    ).rejects.toThrow(/pending account operation/);
    expect(
      (
        await db.query<{ email: string }>(
          "select email from public.profiles where id=$1",
          [outsider],
        )
      ).rows[0].email,
    ).toBe("outsider@example.test");
  } finally {
    await actor();
    await call("abandon_account_operation", [available.requestId]);
  }
});
it("probes only the authenticated actor's request and confirms rejected creates leave no journal", async () => {
  const request = randomUUID();
  await actor();
  await expect(
    call("begin_account_operation", [
      request,
      "create_client",
      { name: "Duplicate", email: "owner@example.test" },
    ]),
  ).rejects.toThrow(/already in use or reserved/);
  expect(await call("account_operation_request_exists", [request])).toBe(false);
  const existing = await begin("create_client", {
    name: "Probe account",
    email: "probe-account@example.test",
  });
  try {
    expect(
      await call("account_operation_request_exists", [existing.requestId]),
    ).toBe(true);
    await actor(owner);
    expect(
      await call("account_operation_request_exists", [existing.requestId]),
    ).toBe(false);
    expect(await call("account_operation_request_exists", [randomUUID()])).toBe(
      false,
    );
    await db.exec("reset role; set role anon");
    await expect(
      call("account_operation_request_exists", [existing.requestId]),
    ).rejects.toMatchObject({ code: "42501" });
  } finally {
    await actor();
    await call("abandon_account_operation", [existing.requestId]);
  }
});

it.each([
  ["ready", false],
  ["ready", true],
  ["skipped", false],
  ["skipped", true],
  ["dispatched", false],
  ["dispatched", true],
  ["accepted", false],
  ["accepted", true],
] as const)(
  "rejects an unmarked password transaction for a %s intent (retained metadata: %s)",
  async (step, retainedMetadata) => {
    await db.exec("reset role");
    await db.query(
      "update auth.users set encrypted_password='before-guard-test' where id=$1",
      [owner],
    );
    const op =
      step === "skipped"
        ? await begin("update_client", {
            target: owner,
            name: "Owner",
            email: null,
            archived: false,
          })
        : await begin("reset_password", { target: owner });
    try {
      if (step === "dispatched" || step === "accepted") {
        const sent = await dispatch(op.requestId);
        if (step === "accepted") await accept(sent, false);
      }
      await db.exec("reset role; begin");
      await db.query(
        retainedMetadata
          ? "update auth.users set encrypted_password='unmarked-guard-test',raw_app_meta_data=raw_app_meta_data||'{\"unrelated\":true}' where id=$1"
          : "update auth.users set encrypted_password='unmarked-guard-test' where id=$1",
        [owner],
      );
      await expect(db.exec("commit")).rejects.toMatchObject({ code: "PBA01" });
      await db.exec("reset role");
      expect(
        (
          await db.query<{ unchanged: boolean }>(
            "select encrypted_password='before-guard-test' unchanged from auth.users where id=$1",
            [owner],
          )
        ).rows[0].unchanged,
      ).toBe(true);
      await actor();
      const current = await call("account_operation_status", [op.requestId]);
      expect(current.authStep).toBe(step);
      await expect(
        call("record_account_event", [owner, "password_reset"]),
      ).rejects.toMatchObject({ code: "PBA01" });
    } finally {
      await db.exec("rollback");
      await actor();
      await call("abandon_account_operation", [op.requestId]);
    }
  },
);

it.each(["password-first", "marker-first"])(
  "accepts multiple password changes only with a current reset receipt in the same transaction (%s)",
  async (order) => {
    const op = await begin("reset_password", { target: owner });
    const sent = await dispatch(op.requestId);
    try {
      await db.exec("reset role; begin");
      if (order === "marker-first") await accept(sent, false);
      await db.query(
        "update auth.users set encrypted_password='first-guard-test' where id=$1",
        [owner],
      );
      await db.query(
        "update auth.users set encrypted_password='final-guard-test' where id=$1",
        [owner],
      );
      if (order === "password-first") await accept(sent, false);
      await db.exec("commit");
      expect(
        (
          await db.query<{ changed: boolean }>(
            "select encrypted_password='final-guard-test' changed from auth.users where id=$1",
            [owner],
          )
        ).rows[0].changed,
      ).toBe(true);
      await actor();
      expect(
        (await call("finish_account_operation", [op.requestId])).status,
      ).toBe("completed");
    } finally {
      await db.exec("rollback");
      await actor();
      await call("abandon_account_operation", [op.requestId]);
    }
  },
);

it("does not let an accepted email-only receipt authorize a password mutation", async () => {
  await db.exec("reset role");
  await db.query(
    "update auth.users set encrypted_password='email-before-guard-test' where id=$1",
    [owner],
  );
  const before = (
    await db.query<{ email: string }>(
      "select email from auth.users where id=$1",
      [owner],
    )
  ).rows[0].email;
  const op = await begin("update_client", {
    target: owner,
    name: "Owner",
    email: "email-only-guard@example.test",
    archived: false,
  });
  const sent = await dispatch(op.requestId);
  try {
    await db.exec("reset role; begin");
    await db.query(
      "update auth.users set email=$2,encrypted_password='email-after-guard-test' where id=$1",
      [owner, "email-only-guard@example.test"],
    );
    await accept(sent, false);
    await expect(db.exec("commit")).rejects.toMatchObject({ code: "PBA01" });
    await db.exec("reset role");
    expect(
      (
        await db.query<{ unchanged: boolean }>(
          "select encrypted_password='email-before-guard-test' and email=$2 unchanged from auth.users where id=$1",
          [owner, before],
        )
      ).rows[0].unchanged,
    ).toBe(true);
    await actor();
    expect(
      (await call("account_operation_status", [op.requestId])).authStep,
    ).toBe("dispatched");
  } finally {
    await db.exec("rollback");
    await actor();
    await call("abandon_account_operation", [op.requestId]);
  }
});

it("preserves no-op passwords and unrelated Auth updates while an intent is pending", async () => {
  const op = await begin("reset_password", { target: owner });
  try {
    await dispatch(op.requestId);
    await db.exec("reset role");
    await db.query(
      'update auth.users set encrypted_password=encrypted_password,raw_app_meta_data=raw_app_meta_data||\'{"ordinary":true}\',raw_user_meta_data=\'{"display_name":"ordinary update"}\',email_confirmed_at=now() where id=$1',
      [owner],
    );
    expect(
      (
        await db.query<{ ordinary: boolean }>(
          "select (raw_app_meta_data->>'ordinary')::boolean ordinary from auth.users where id=$1",
          [owner],
        )
      ).rows[0].ordinary,
    ).toBe(true);
    await actor();
    expect(
      (await call("account_operation_status", [op.requestId])).authStep,
    ).toBe("dispatched");
  } finally {
    await actor();
    await call("abandon_account_operation", [op.requestId]);
  }
});

it.each(["completed", "abandoned"])(
  "allows an ordinary password update with a retained %s marker and no unresolved intent",
  async (terminal) => {
    const op = await begin("reset_password", { target: owner });
    const sent = await dispatch(op.requestId);
    await accept(sent, false);
    await actor();
    await call(
      terminal === "completed"
        ? "finish_account_operation"
        : "abandon_account_operation",
      [op.requestId],
    );
    await db.exec("reset role");
    await db.query(
      "update auth.users set encrypted_password=$2,raw_app_meta_data=raw_app_meta_data||'{\"ordinary\":true}' where id=$1",
      [owner, `ordinary-${terminal}-guard-test`],
    );
    expect(
      (
        await db.query<{ changed: boolean }>(
          "select encrypted_password=$2 changed from auth.users where id=$1",
          [owner, `ordinary-${terminal}-guard-test`],
        )
      ).rows[0].changed,
    ).toBe(true);
  },
);

it.each(["create_client", "create_bidder"])(
  "allows deferred password initialization for an accepted %s transaction",
  async (kind) => {
    const op = await begin(kind, {
      name: "Password guard creation",
      email: `${kind}-guard@example.test`,
      ...(kind === "create_bidder" ? { workspace, rate: 123 } : {}),
    });
    const sent = await dispatch(op.requestId);
    try {
      await db.exec("reset role; begin");
      await db.query("insert into auth.users(id,email) values($1,$2)", [
        sent.targetId,
        (sent.payload as { email: string }).email,
      ]);
      await db.query(
        "update auth.users set encrypted_password='creation-guard-test' where id=$1",
        [sent.targetId],
      );
      await accept(sent, false);
      await db.exec("commit");
      await actor();
      expect(
        (await call("finish_account_operation", [op.requestId])).status,
      ).toBe("completed");
    } finally {
      await db.exec("rollback");
      await actor();
      await call("abandon_account_operation", [op.requestId]);
    }
  },
);

it("still rejects unmarked creation at the existing deferred provisioning guard", async () => {
  const op = await begin("create_client", {
    name: "Unmarked creation",
    email: "unmarked-creation-guard@example.test",
  });
  try {
    await db.exec("reset role; begin");
    await db.query(
      "insert into auth.users(id,email,encrypted_password) values($1,$2,'unmarked-creation-guard-test')",
      [op.targetId, (op.payload as { email: string }).email],
    );
    await expect(db.exec("commit")).rejects.toMatchObject({ code: "PBA01" });
    await db.exec("reset role");
    expect(
      (
        await db.query<{ absent: boolean }>(
          "select not exists(select 1 from auth.users where id=$1) absent",
          [op.targetId],
        )
      ).rows[0].absent,
    ).toBe(true);
  } finally {
    await db.exec("rollback");
    await actor();
    await call("abandon_account_operation", [op.requestId]);
  }
});

it("does not expose the password guard as a client-callable helper", async () => {
  await db.exec("reset role");
  expect(
    (
      await db.query<{ allowed: boolean }>(
        "select has_function_privilege('authenticated','public.guard_account_auth_password_write()','EXECUTE') or has_function_privilege('anon','public.guard_account_auth_password_write()','EXECUTE') or has_function_privilege('service_role','public.guard_account_auth_password_write()','EXECUTE') allowed",
      )
    ).rows[0].allowed,
  ).toBe(false);
});

it("allows an ordinary no-intent password change without a managed marker", async () => {
  await db.exec("reset role");
  await db.query(
    "update auth.users set raw_app_meta_data=raw_app_meta_data-'managed_account_operation',encrypted_password='no-intent-guard-test' where id=$1",
    [owner],
  );
  expect(
    (
      await db.query<{ changed: boolean }>(
        "select encrypted_password='no-intent-guard-test' changed from auth.users where id=$1",
        [owner],
      )
    ).rows[0].changed,
  ).toBe(true);
});

it("rolls back password changes when current actor permission rejects the marker", async () => {
  const op = await begin("reset_password", { target: owner });
  const sent = await dispatch(op.requestId);
  await db.exec("reset role");
  await db.query("update public.profiles set archived=true where id=$1", [
    admin,
  ]);
  try {
    await db.exec("begin");
    await db.query(
      "update auth.users set encrypted_password='revoked-guard-test' where id=$1",
      [owner],
    );
    await expect(accept(sent, false)).rejects.toThrow(/Access denied/);
    await db.exec("rollback; reset role");
    expect(
      (
        await db.query<{ unchanged: boolean }>(
          "select encrypted_password is distinct from 'revoked-guard-test' unchanged from auth.users where id=$1",
          [owner],
        )
      ).rows[0].unchanged,
    ).toBe(true);
  } finally {
    await db.exec("rollback; reset role");
    await db.query("update public.profiles set archived=false where id=$1", [
      admin,
    ]);
    await actor();
    expect(
      (await call("account_operation_status", [op.requestId])).authStep,
    ).toBe("dispatched");
    await call("abandon_account_operation", [op.requestId]);
  }
});
