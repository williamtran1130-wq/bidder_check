import {
  test,
  expect,
  type Browser,
  type BrowserContext,
} from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@/lib/database.types";
import type { AccountOperation } from "@/lib/account-operation-types";

test.skip(
  process.env.BIDDER_SECURITY_INTEGRATION !== "1",
  "Requires an explicitly configured local Supabase stack with all migrations applied.",
);

test("real browser sessions, refresh tokens and direct API access are revoked without affecting other users", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180000);
  const url = process.env.BIDDER_SECURITY_SUPABASE_URL!;
  const database = process.env.BIDDER_SECURITY_DATABASE_URL!;
  for (const value of [url, database])
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(
      new URL(value).hostname,
    );
  const key = process.env.BIDDER_SECURITY_PUBLISHABLE_KEY!;
  const service = createClient<Database>(
    url,
    process.env.BIDDER_SECURITY_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const sql = new pg.Client({ connectionString: database });
  await sql.connect();
  const ids: string[] = [],
    contexts: BrowserContext[] = [];
  const storedPaths: string[] = [];
  const suffix = randomUUID();
  const initial = `Initial-${suffix}`,
    changed = `Changed-${suffix}`;
  const caller = (token: string) =>
    createClient<Database>(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
  const check = <T extends { data: unknown; error: unknown }>(
    result: T,
  ): T["data"] => {
    expect(result.error).toBeNull();
    return result.data;
  };
  async function account(email: string) {
    const data = check(
      await service.auth.admin.createUser({
        email,
        password: initial,
        email_confirm: true,
      }),
    );
    ids.push(data.user!.id);
    await sql.query(
      "update public.profiles set approval_status='approved' where id=$1",
      [data.user!.id],
    );
    return data.user!.id;
  }
  async function login(browser: Browser, email: string, password = initial) {
    const context = await browser.newContext({ baseURL });
    contexts.push(context);
    let cookies: { name: string; value: string }[] = [];
    const client = createServerClient<Database>(url, key, {
      cookies: {
        getAll: () => cookies,
        setAll: (values) => {
          for (const value of values) {
            cookies = cookies.filter((row) => row.name !== value.name);
            cookies.push({ name: value.name, value: value.value });
          }
        },
      },
    });
    const { session } = check(
      await client.auth.signInWithPassword({ email, password }),
    );
    expect(session).not.toBeNull();
    await context.addCookies(
      cookies
        .filter((row) => row.value)
        .map((row) => ({ ...row, url: baseURL!, sameSite: "Lax" as const })),
    );
    const page = await context.newPage();
    await page.goto("/dashboard");
    await expect(page).not.toHaveURL(/\/auth\/login/);
    return {
      context,
      page,
      session: session!,
      api: caller(session!.access_token),
    };
  }
  async function bidderAccount(
    owner: SupabaseClient<Database>,
    ownerId: string,
    email: string,
  ) {
    const workspace = (
      await sql.query<{ id: string }>(
        "select id from public.workspaces where owner_id=$1",
        [ownerId],
      )
    ).rows[0].id;
    const request = randomUUID();
    const op = check(
      await owner.rpc("begin_account_operation", {
        p_request: request,
        p_kind: "create_bidder",
        p_payload: { name: email, email, workspace, rate: 100 },
      }),
    ) as AccountOperation;
    ids.push(op.targetId);
    const sent = check(
      await service.rpc("dispatch_account_operation", {
        p_request: request,
        p_actor: ownerId,
        p_password_commitment: null,
      }),
    ) as AccountOperation;
    check(
      await service.auth.admin.createUser({
        id: op.targetId,
        email,
        password: initial,
        email_confirm: true,
        app_metadata: {
          managed_account_operation: { request, dispatch: sent.dispatchId },
        },
      }),
    );
    check(await owner.rpc("finish_account_operation", { p_request: request }));
    return op.targetId;
  }
  try {
    const ownerEmail = `security-owner-${suffix}@example.test`,
      email = `security-bidder-${suffix}@example.test`,
      otherEmail = `security-other-${suffix}@example.test`;
    const ownerId = await account(ownerEmail);
    const manager = await login(browser, ownerEmail);
    const bidderId = await bidderAccount(manager.api, ownerId, email);
    await bidderAccount(manager.api, ownerId, otherEmail);
    const a = await login(browser, email),
      b = await login(browser, email),
      other = await login(browser, otherEmail);
    const workspace = (
      await sql.query<{ id: string }>(
        "select id from public.workspaces where owner_id=$1",
        [ownerId],
      )
    ).rows[0].id;
    const profile = check(
      await manager.api.rpc("save_candidate_profile", {
        p_id: null,
        p_workspace: workspace,
        p_identifier: `SECURITY-${suffix}`,
        p_name: "Integration candidate",
        p_address: "",
        p_links: "",
        p_instructions: "",
      }),
    );
    const resume = check(
      await manager.api.rpc("save_resume_assignment", {
        p_id: null,
        p_profile: profile,
        p_bidder: bidderId,
        p_email: email,
        p_phone: "555-0100",
        p_file: null,
        p_rate: null,
      }),
    );
    const contents = "%PDF-1.7\nLocal session revocation fixture\n%%EOF\n";
    const upload = check(
      await manager.api.rpc("prepare_file", {
        p_kind: "resume",
        p_target: resume,
        p_name: "session-probe.pdf",
        p_mime: "application/pdf",
        p_size: Buffer.byteLength(contents),
      }),
    );
    const metadata = check(
      await manager.api
        .from("files")
        .select("storage_path")
        .eq("id", upload!)
        .single(),
    )!;
    storedPaths.push(metadata.storage_path);
    check(
      await manager.api.storage
        .from("private-files")
        .upload(
          metadata.storage_path,
          new Blob([contents], { type: "application/pdf" }),
        ),
    );
    check(
      await service.rpc("finalize_verified_file", {
        p_id: upload,
        p_actor: ownerId,
        p_sha: createHash("sha256").update(contents).digest("hex"),
      }),
    );
    const download = (token: string) =>
      fetch(
        `${url}/storage/v1/object/private-files/${metadata.storage_path}?cacheNonce=${randomUUID()}`,
        {
          headers: { apikey: key, Authorization: `Bearer ${token}` },
          cache: "no-store",
        },
      );
    for (const session of [a, b, manager]) {
      const response = await download(session.session.access_token);
      expect(response.ok).toBe(true);
      expect(await response.text()).toBe(contents);
    }
    await manager.page.goto("/users");
    await manager.page.getByLabel("Search people").fill(email);
    await manager.page
      .getByRole("button", { name: "Manage", exact: true })
      .click();
    let dialog = manager.page.getByRole("dialog");
    await dialog.getByLabel("Confirm sign out on all devices").check();
    await dialog
      .getByRole("button", { name: "Sign out all devices", exact: true })
      .click();
    await expect(
      manager.page.getByText("Bidder signed out on all devices", {
        exact: true,
      }),
    ).toBeVisible();
    for (const old of [a, b]) {
      expect((await download(old.session.access_token)).ok).toBe(false);
      expect((await old.api.from("profiles").select("id")).error?.code).toBe(
        "PT401",
      );
      expect((await old.api.rpc("list_account_operations")).error?.code).toBe(
        "PT401",
      );
      const refresh = await old.context.request.post(
        `${url}/auth/v1/token?grant_type=refresh_token`,
        {
          headers: { apikey: key },
          data: { refresh_token: old.session.refresh_token },
        },
      );
      expect(refresh.ok()).toBe(false);
      await old.page.goto("/dashboard");
      await expect(old.page).toHaveURL(/\/auth\/login/);
      expect(
        (await old.context.request.get(`${baseURL}/api/read/purges`)).status(),
      ).toBe(401);
    }
    expect((await manager.api.rpc("enforce_live_session")).error).toBeNull();
    expect((await other.api.rpc("enforce_live_session")).error).toBeNull();
    const fresh = await login(browser, email);
    expect((await download(fresh.session.access_token)).ok).toBe(true);
    expect((await download(manager.session.access_token)).ok).toBe(true);
    await manager.page.keyboard.press("Escape");
    await manager.page
      .getByRole("button", { name: "Manage", exact: true })
      .click();
    dialog = manager.page.getByRole("dialog");
    await dialog.getByLabel("New password", { exact: true }).fill(changed);
    await dialog.getByLabel("Confirm password", { exact: true }).fill(changed);
    await dialog
      .getByRole("button", { name: "Change password", exact: true })
      .click();
    await expect(
      manager.page.getByText(
        "Password changed. Bidder signed out on all devices.",
        { exact: true },
      ),
    ).toBeVisible();
    expect((await fresh.api.rpc("enforce_live_session")).error?.code).toBe(
      "PT401",
    );
    expect((await download(fresh.session.access_token)).ok).toBe(false);
    expect((await download(manager.session.access_token)).ok).toBe(true);
    const authentication = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    expect(
      (
        await authentication.auth.signInWithPassword({
          email,
          password: initial,
        })
      ).error,
    ).not.toBeNull();
    const changedSession = await login(browser, email, changed);
    expect((await download(changedSession.session.access_token)).ok).toBe(true);
    expect((await manager.api.rpc("enforce_live_session")).error).toBeNull();
    expect((await other.api.rpc("enforce_live_session")).error).toBeNull();
    const raw = (
      await sql.query(
        "select payload,password_commitment from public.account_operations where target_id=$1 and kind='set_bidder_password'",
        [bidderId],
      )
    ).rows;
    expect(raw).toHaveLength(1);
    expect(JSON.stringify(raw)).not.toContain(changed);
    expect(raw[0].password_commitment).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    if (storedPaths.length)
      check(await service.storage.from("private-files").remove(storedPaths));
    // These IDs were created by this test against an explicitly local instance.
    await sql.query(
      "delete from public.account_operations where actor_id=any($1::uuid[]) or target_id=any($1::uuid[])",
      [ids],
    );
    await sql.query(
      "delete from public.account_events where actor_id=any($1::uuid[]) or account_id=any($1::uuid[])",
      [ids],
    );
    await sql.query("delete from public.invitations where id=any($1::uuid[])", [
      ids,
    ]);
    await sql.query(
      "update public.resumes set file_id=null where bidder_id=any($1::uuid[])",
      [ids],
    );
    await sql.query(
      "delete from public.files where bidder_id=any($1::uuid[])",
      [ids],
    );
    await sql.query(
      "delete from public.resumes where bidder_id=any($1::uuid[])",
      [ids],
    );
    await sql.query(
      "delete from public.candidate_profiles where workspace_id in (select id from public.workspaces where owner_id=any($1::uuid[]))",
      [ids],
    );
    await sql.query(
      "delete from public.storage_cleanup_tasks where storage_path=any($1::text[])",
      [storedPaths],
    );
    await sql.query(
      "delete from public.bidders where user_id=any($1::uuid[])",
      [ids],
    );
    await sql.query(
      "delete from public.workspaces where owner_id=any($1::uuid[])",
      [ids],
    );
    await sql.query("delete from public.profiles where id=any($1::uuid[])", [
      ids,
    ]);
    for (const id of ids) check(await service.auth.admin.deleteUser(id));
    await sql.end();
  }
});
