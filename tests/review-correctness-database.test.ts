import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";

// Executes all 49 baseline migrations with provider-style default grants.
// Lock-boundary injections below are deterministic single-session regressions,
// not evidence that independent PostgreSQL sessions correctly wait/replay.
let db: PGlite;
const owner = "19000000-0000-4000-8000-000000000001";
const bidder = "19000000-0000-4000-8000-000000000002";
const other = "19000000-0000-4000-8000-000000000003";
const request = "19000000-0000-4000-8000-000000000004";
const correction = "supabase/migrations/202610130019_review_correctness.sql";
let workspace: string, profile: string, resume: string;
let intendedAssignment: string;

async function asUser(id = owner) {
  await db.exec("reset role; set role authenticated");
  await db.query(
    "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",
    [id],
  );
}

async function isolated(run: () => Promise<void>) {
  await db.exec("reset role; begin");
  try {
    await run();
  } finally {
    await db.exec("rollback; reset role");
  }
}

// An expected PostgreSQL error aborts the current transaction; savepoints let
// the remaining assertions inspect whether the rejected operation was atomic.
async function attempt(sql: string, params: unknown[]) {
  await db.exec("savepoint expected_error");
  try {
    return await db.query(sql, params);
  } catch (error) {
    await db.exec("rollback to savepoint expected_error");
    throw error;
  } finally {
    await db.exec("release savepoint expected_error");
  }
}

async function applyCorrection() {
  if (existsSync(correction)) await db.exec(readFileSync(correction, "utf8"));
}

async function atAdvisoryBoundary(signature: string, body: string) {
  // PGlite's advisory intrinsic does not dispatch a replaced pg_catalog body.
  // Substitute this dependency only; execute the final catalog RPC body with
  // all of its real reads, checks, writes, receipts and triggers intact.
  await db.exec(
    `create function public.review_advisory_boundary(bigint) returns void language plpgsql as $$begin ${body} end $$`,
  );
  const definition = (
    await db.query<{ definition: string }>(
      "select pg_get_functiondef($1::regprocedure) definition",
      [signature],
    )
  ).rows[0].definition;
  await db.exec(
    definition.replaceAll(
      "pg_advisory_xact_lock(",
      "public.review_advisory_boundary(",
    ),
  );
}

async function seedBid(applied = true) {
  const id = (
    await db.query<{ id: string }>(
      `
    insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,
      arrangement,found_at,applied,application_method,rate_cents,applied_at,first_applied_at,review_status)
    values($1,$2,$3,'Lock fixture','Engineer','https://review.invalid/lock','https://review.invalid/lock',
      'hybrid',clock_timestamp()-interval '4 months',$4,
      case when $4 then 'manual' end,case when $4 then 125 end,
      case when $4 then clock_timestamp()-interval '3 months' end,
      case when $4 then clock_timestamp()-interval '3 months' end,'approved') returning id`,
      [workspace, bidder, resume, applied],
    )
  ).rows[0].id;
  await db.query(
    "update public.bids set review_status='approved',review_revision=1 where id=$1",
    [id],
  );
  return id;
}

async function cleanup() {
  await db.exec(
    "reset role; set role service_role; select set_config('request.jwt.claim.role','service_role',false)",
  );
  const result = (
    await db.query<{ result: unknown }>(
      "select public.process_candidate_retention(10) result",
    )
  ).rows[0].result;
  await db.exec("reset role");
  return result;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
    alter table storage.objects enable row level security;
    grant usage on schema auth,storage to authenticated,service_role;
    grant all on storage.objects to authenticated,service_role;
    alter default privileges in schema public grant execute on functions to authenticated,service_role;`);
  const baseline = readdirSync("supabase/migrations")
    .filter(
      (file) =>
        file.endsWith(".sql") &&
        file <= "202610120018_grouped_evidence_size_counts.sql",
    )
    .sort();
  expect(baseline).toHaveLength(49);
  for (const file of baseline)
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  intendedAssignment = (
    await db.query<{ definition: string }>(
      "select pg_get_functiondef('public.save_resume_assignment(uuid,uuid,uuid,text,text,uuid,integer)'::regprocedure) definition",
    )
  ).rows[0].definition;
  await applyCorrection();
  await db.query(
    "insert into auth.users(id,email) values($1,'owner@review.invalid'),($2,'bidder@review.invalid'),($3,'other@review.invalid')",
    [owner, bidder, other],
  );
  await db.exec("update public.profiles set approval_status='approved'");
  workspace = (
    await db.query<{ id: string }>(
      "select id from public.workspaces where owner_id=$1",
      [owner],
    )
  ).rows[0].id;
  await db.query("update public.profiles set role='bidder' where id=$1", [
    bidder,
  ]);
  await db.query(
    "insert into public.bidders(user_id,workspace_id,default_rate_cents) values($1,$2,125)",
    [bidder, workspace],
  );
  profile = (
    await db.query<{ id: string }>(
      "insert into public.candidate_profiles(workspace_id,identifier,candidate_name,retention_months) values($1,'Review fixture','Review',2) returning id",
      [workspace],
    )
  ).rows[0].id;
  resume = (
    await db.query<{ id: string }>(
      "insert into public.resumes(workspace_id,bidder_id,profile_id,identifier,candidate_name,email,phone) values($1,$2,$3,'Review fixture','Review','review@example.invalid','555-0100') returning id",
      [workspace, bidder, profile],
    )
  ).rows[0].id;
}, 60000);

afterAll(async () => {
  await db?.close();
});

it.each([null, 6])(
  "preserves bid, event, screenshot and upload context when policy becomes %s at the profile lock boundary",
  async (months) => {
    await isolated(async () => {
      const bid = await seedBid();
      const file = (
        await db.query<{ id: string }>(
          "insert into public.files(workspace_id,bidder_id,kind,bid_id,filename,mime,size_bytes,storage_path,created_by,review_revision) values($1,$2,'screenshot',$3,'proof.png','image/png',100,'review/proof.png',$2,1) returning id",
          [workspace, bidder, bid],
        )
      ).rows[0].id;
      await db.query(
        "insert into public.bid_events(bid_id,actor_id,event) values($1,$2,'created')",
        [bid, bidder],
      );
      await db.query(
        "insert into public.screenshot_upload_contexts(bid_id,workspace_id,bidder_id,original_file_id,uploader_id,uploader_role,uploaded_at,source,status) values($1,$2,$3,$4,$3,'bidder',now(),'unavailable','unavailable')",
        [bid, workspace, bidder, file],
      );
      // Inject the state a policy writer commits while the worker waits. Replace
      // only the advisory dependency, transactionally; the production RPC is real.
      await atAdvisoryBoundary(
        "public.process_candidate_retention(integer)",
        `update public.candidate_profiles set retention_months=${months === null ? "null" : months} where id='${profile}';`,
      );
      expect(await cleanup()).toEqual({
        deletedApplications: 0,
        storageTasksQueued: 0,
        limit: 10,
      });
      expect(
        (
          await db.query(
            "select (select count(*)::int from public.bids) bids,(select count(*)::int from public.bid_events) events,(select count(*)::int from public.files) files,(select count(*)::int from public.screenshot_upload_contexts) contexts,(select count(*)::int from public.retained_bid_daily_aggregates) aggregates,(select count(*)::int from public.storage_cleanup_tasks) tasks",
          )
        ).rows,
      ).toEqual([
        { bids: 1, events: 1, files: 1, contexts: 1, aggregates: 0, tasks: 0 },
      ]);
    });
  },
);

it("uses a shorter current policy at the lock boundary and preserves retained totals and cascading context cleanup", async () => {
  await isolated(async () => {
    await db.query(
      "update public.candidate_profiles set retention_months=6 where id=$1",
      [profile],
    );
    const bid = await seedBid();
    const file = (
      await db.query<{ id: string }>(
        "insert into public.files(workspace_id,bidder_id,kind,bid_id,filename,mime,size_bytes,storage_path,created_by,review_revision) values($1,$2,'screenshot',$3,'proof.png','image/png',100,'review/proof.png',$2,1) returning id",
        [workspace, bidder, bid],
      )
    ).rows[0].id;
    await db.query(
      "insert into public.bid_events(bid_id,actor_id,event) values($1,$2,'created')",
      [bid, bidder],
    );
    await db.query(
      "insert into public.screenshot_upload_contexts(bid_id,workspace_id,bidder_id,original_file_id,uploader_id,uploader_role,uploaded_at,source,status) values($1,$2,$3,$4,$3,'bidder',now(),'unavailable','unavailable')",
      [bid, workspace, bidder, file],
    );
    await atAdvisoryBoundary(
      "public.process_candidate_retention(integer)",
      `update public.candidate_profiles set retention_months=2 where id='${profile}';`,
    );
    expect(await cleanup()).toEqual({
      deletedApplications: 1,
      storageTasksQueued: 1,
      limit: 10,
    });
    expect(
      (
        await db.query(
          "select metric,record_count::int,earned_cents::int,hybrid_count::int from public.retained_bid_daily_aggregates order by metric",
        )
      ).rows,
    ).toEqual([
      {
        metric: "applied_activity",
        record_count: 1,
        earned_cents: 0,
        hybrid_count: 0,
      },
      {
        metric: "earning",
        record_count: 1,
        earned_cents: 125,
        hybrid_count: 0,
      },
      { metric: "found", record_count: 1, earned_cents: 0, hybrid_count: 1 },
    ]);
    expect(
      (
        await db.query(
          "select (select count(*)::int from public.bids) bids,(select count(*)::int from public.bid_events) events,(select count(*)::int from public.files) files,(select count(*)::int from public.screenshot_upload_contexts) contexts",
        )
      ).rows,
    ).toEqual([{ bids: 0, events: 0, files: 0, contexts: 0 }]);
    expect(await cleanup()).toEqual({
      deletedApplications: 0,
      storageTasksQueued: 0,
      limit: 10,
    });
  });
});

it("replays a receipt committed at the first manual lock boundary before validating obsolete target versions", async () => {
  await isolated(async () => {
    const bid = await seedBid(false);
    const stamp = "2026-01-02T12:00:00Z";
    await db.query(
      "update public.bids set found_at='2026-01-01T12:00:00Z' where id=$1",
      [bid],
    );
    const targets = JSON.stringify([{ id: bid, version: 0 }]);
    await db.query(
      `select set_config('review.fixture.fingerprint',md5(jsonb_build_object(
      'targets',$1::jsonb,'applied_at',$2::timestamptz,'reason','Boundary replay')::text),true)`,
      [targets, stamp],
    );
    // The state represents the winning transaction's committed mutation and
    // receipt. Without a request lock, the first boundary is a profile lock and
    // the old implementation continues into its now-stale version check.
    await atAdvisoryBoundary(
      "public.manual_apply_bids(jsonb,timestamptz,text,uuid)",
      `
        if not exists(select 1 from public.manual_application_receipts where actor_id='${owner}' and request_id='${request}') then
          update public.bids set applied=true,application_method='manual',rate_cents=125,
            applied_at='${stamp}',first_applied_at='${stamp}',version=version+1 where id='${bid}';
          insert into public.bid_events(bid_id,actor_id,event,reason) values('${bid}','${owner}','application_manual','Boundary replay');
          insert into public.manual_application_receipts(actor_id,request_id,fingerprint,result)
            values('${owner}','${request}',current_setting('review.fixture.fingerprint'),' {"applied":1,"unchanged":0}'::jsonb);
        end if;
      `,
    );
    await asUser();
    expect(
      (
        await db.query<{ result: unknown }>(
          "select public.manual_apply_bids($1,$2,'Boundary replay',$3) result",
          [targets, stamp, request],
        )
      ).rows[0].result,
    ).toEqual({ applied: 1, unchanged: 0 });
    await db.exec("reset role");
    expect(
      (
        await db.query(
          "select (select count(*)::int from public.manual_application_receipts) receipts,(select count(*)::int from public.bid_events where event='application_manual') events,(select version from public.bids limit 1) version",
        )
      ).rows,
    ).toEqual([{ receipts: 1, events: 1, version: 1 }]);
  });
});

it("preserves manual fingerprints, rate snapshots, authorization and sequential receipt replay", async () => {
  await isolated(async () => {
    const bid = await seedBid(false);
    await db.query(
      "update public.bids set found_at='2026-01-01T12:00:00Z' where id=$1",
      [bid],
    );
    const targets = JSON.stringify([{ id: bid, version: 0 }]);
    const stamp = "2026-01-02T12:00:00Z";
    await asUser();
    const call = () =>
      db.query<{ result: unknown }>(
        "select public.manual_apply_bids($1,$2,'Reviewed manually',$3) result",
        [targets, stamp, request],
      );
    expect((await call()).rows[0].result).toEqual({ applied: 1, unchanged: 0 });
    expect((await call()).rows[0].result).toEqual({ applied: 1, unchanged: 0 });
    await expect(
      attempt("select public.manual_apply_bids($1,$2,'Different reason',$3)", [
        targets,
        stamp,
        request,
      ]),
    ).rejects.toThrow(/already used for different content/);
    await db.exec("reset role");
    expect(
      (
        await db.query(
          "select applied,application_method,rate_cents,version,first_applied_at=applied_at first_is_latest from public.bids where id=$1",
          [bid],
        )
      ).rows,
    ).toEqual([
      {
        applied: true,
        application_method: "manual",
        rate_cents: 125,
        version: 1,
        first_is_latest: true,
      },
    ]);
    expect(
      (
        await db.query(
          "select count(*)::int n from public.bid_events where bid_id=$1 and event='application_manual'",
          [bid],
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
    await db.query("update public.profiles set archived=true where id=$1", [
      owner,
    ]);
    await asUser();
    await expect(
      attempt("select public.manual_apply_bids($1,$2,'Reviewed manually',$3)", [
        targets,
        stamp,
        request,
      ]),
    ).rejects.toThrow(/Only active clients and admins/);
  });
});

const repairedFunctions = [
  "public.candidate_bid_issues(uuid,uuid,text,text,text)",
  "public.finish_push_attempt(uuid,uuid,text,boolean)",
  "public.message_occurrence_at(date,time)",
  "public.next_message_occurrence(timestamptz,time,smallint[],boolean)",
  "public.process_due_messages(timestamptz,integer)",
];

it.each(repairedFunctions)(
  "removes effective authenticated/anon execution from %s under provider default grants",
  async (signature) => {
    await db.exec("reset role");
    const grants = (
      await db.query(
        "select has_function_privilege('authenticated',$1,'execute') authenticated,has_function_privilege('anon',$1,'execute') anon,has_function_privilege('service_role',$1,'execute') service",
        [signature],
      )
    ).rows[0];
    expect(grants).toEqual({
      authenticated: false,
      anon: false,
      service: signature !== repairedFunctions[0],
    });
  },
);

it("denies the internal issue helper directly while keeping restricted parent writes and import validation functional", async () => {
  await isolated(async () => {
    const upload = (
      await db.query<{ id: string }>(
        "insert into public.files(workspace_id,bidder_id,kind,resume_id,filename,mime,size_bytes,storage_path,created_by,finalized) values($1,$2,'resume',$3,'resume.pdf','application/pdf',100,'review/resume.pdf',$4,true) returning id",
        [workspace, bidder, resume, owner],
      )
    ).rows[0].id;
    await db.query("update public.resumes set file_id=$1 where id=$2", [
      upload,
      resume,
    ]);
    await db.query(
      "update public.candidate_profiles set restricted_companies=array['blocked'] where id=$1",
      [profile],
    );
    await asUser(bidder);
    await expect(
      attempt(
        "select public.candidate_bid_issues($1,null,'Allowed','Engineer','https://review.invalid/allowed')",
        [profile],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const bid = (
      await db.query<{ id: string }>(
        "select public.save_bid(null,$1,'Allowed','Engineer','https://review.invalid/allowed','','remote','open') id",
        [resume],
      )
    ).rows[0].id;
    expect(bid).toBeTruthy();
    await expect(
      attempt(
        "select public.save_bid(null,$1,'Blocked','Engineer','https://review.invalid/blocked','','remote','open')",
        [resume],
      ),
    ).rejects.toMatchObject({ code: "PBC01" });
    const rows = JSON.stringify([
      {
        company: "Blocked",
        role_name: "Engineer",
        url: "https://review.invalid/import",
        source: "",
        arrangement: "remote",
        job_status: "open",
      },
    ]);
    const validation = (
      await db.query<{ result: { issues: { code: string }[] } }>(
        "select public.validate_bid_import($1,'2026-01-01',$2) result",
        [resume, rows],
      )
    ).rows[0].result;
    expect(JSON.stringify(validation)).toContain("restricted_company");
    const reviewed = (
      await db.query<{
        result: {
          ids: string[];
          sourceRows: number[];
          skipped: { sourceRow: number }[];
        };
      }>(
        "select public.import_bids_reviewed($1,'2026-01-01',$2,array[17],$3) result",
        [resume, rows, request],
      )
    ).rows[0].result;
    expect(reviewed.ids).toEqual([]);
    expect(reviewed.sourceRows).toEqual([]);
    expect(reviewed.skipped.map((row) => row.sourceRow)).toEqual([17]);
    expect(
      (
        await db.query<{ result: unknown }>(
          "select public.import_bids_reviewed($1,'2026-01-01',$2,array[17],$3) result",
          [resume, rows, request],
        )
      ).rows[0].result,
    ).toEqual(reviewed);
    await asUser(other);
    await expect(
      attempt(
        "select public.candidate_bid_issues($1,null,'Allowed','Engineer','https://review.invalid/allowed')",
        [profile],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

it("keeps assignment bidder-change file clearing and rejects moving assignments with bid history", async () => {
  await isolated(async () => {
    await db.query("update public.profiles set role='bidder' where id=$1", [
      other,
    ]);
    await db.query(
      "insert into public.bidders(user_id,workspace_id,default_rate_cents) values($1,$2,150)",
      [other, workspace],
    );
    const file = (
      await db.query<{ id: string }>(
        "insert into public.files(workspace_id,bidder_id,kind,resume_id,filename,mime,size_bytes,storage_path,created_by,finalized) values($1,$2,'resume',$3,'resume.pdf','application/pdf',100,'review/moving.pdf',$4,true) returning id",
        [workspace, bidder, resume, owner],
      )
    ).rows[0].id;
    await db.query("update public.resumes set file_id=$1 where id=$2", [
      file,
      resume,
    ]);
    await asUser();
    await db.query(
      "select public.save_resume_assignment($1,$2,$3,'other@example.invalid','555-0101',null,150)",
      [resume, profile, other],
    );
    await db.exec("reset role");
    expect(
      (
        await db.query(
          "select bidder_id,file_id,rate_override_cents from public.resumes where id=$1",
          [resume],
        )
      ).rows,
    ).toEqual([{ bidder_id: other, file_id: null, rate_override_cents: 150 }]);
    await asUser();
    await db.query(
      "select public.save_resume_assignment($1,$2,$3,'review@example.invalid','555-0100',$4,null)",
      [resume, profile, bidder, file],
    );
    await db.exec("reset role");
    await seedBid(false);
    await asUser();
    await expect(
      attempt(
        "select public.save_resume_assignment($1,$2,$3,'other@example.invalid','555-0101',null,150)",
        [resume, profile, other],
      ),
    ).rejects.toThrow(/bid history cannot be moved/);
    await asUser(other);
    await expect(
      attempt(
        "select public.save_resume_assignment($1,$2,$3,'other@example.invalid','555-0101',null,150)",
        [resume, profile, other],
      ),
    ).rejects.toThrow(/Access denied/);
  });
});

it("restores assignment precheck drift while preserving the independent file ownership trigger", async () => {
  await isolated(async () => {
    // This is the observed looser deployed precheck, not removal of the guard.
    await db.exec(intendedAssignment.replace("and f.resume_id=p_id", ""));
    await applyCorrection();
    const secondProfile = (
      await db.query<{ id: string }>(
        "insert into public.candidate_profiles(workspace_id,identifier,candidate_name) values($1,'Second','Review') returning id",
        [workspace],
      )
    ).rows[0].id;
    const second = (
      await db.query<{ id: string }>(
        "insert into public.resumes(workspace_id,bidder_id,profile_id,identifier,candidate_name) values($1,$2,$3,'Second','Review') returning id",
        [workspace, bidder, secondProfile],
      )
    ).rows[0].id;
    const file = (
      await db.query<{ id: string }>(
        "insert into public.files(workspace_id,bidder_id,kind,resume_id,filename,mime,size_bytes,storage_path,created_by,finalized) values($1,$2,'resume',$3,'resume.pdf','application/pdf',100,'review/assignment.pdf',$4,true) returning id",
        [workspace, bidder, resume, owner],
      )
    ).rows[0].id;
    await asUser();
    await expect(
      attempt(
        "select public.save_resume_assignment($1,$2,$3,'review@example.invalid','555-0100',$4,null)",
        [second, secondProfile, bidder, file],
      ),
    ).rejects.toThrow(/Choose a verified PDF assigned to this bidder/);
    expect(
      (
        await db.query<{ id: string }>(
          "select public.save_resume_assignment($1,$2,$3,'review@example.invalid','555-0100',$4,null) id",
          [resume, profile, bidder, file],
        )
      ).rows[0].id,
    ).toBe(resume);
    await db.exec("reset role");
    await expect(
      attempt("update public.resumes set file_id=$1 where id=$2", [
        file,
        second,
      ]),
    ).rejects.toThrow(/Resume PDF must be verified for this bidder assignment/);
    expect(
      (
        await db.query(
          "select tgenabled from pg_trigger where tgrelid='public.resumes'::regclass and tgname='guard_resume_assignment_file'",
        )
      ).rows,
    ).toEqual([{ tgenabled: "O" }]);
  });
});
