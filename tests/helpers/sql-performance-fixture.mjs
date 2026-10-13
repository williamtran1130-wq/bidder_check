import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";

export async function createFixture(count = 120) {
  const db = new PGlite();
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
    alter default privileges in schema public grant execute on functions to service_role;
    alter default privileges in schema public grant all on tables to service_role;`);
  for (const file of readdirSync("supabase/migrations")
    .filter(
      (f) => f.endsWith(".sql") && f <= "202610130019_review_correctness.sql",
    )
    .sort())
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  const actors = {};
  for (const name of [
    "owner",
    "admin",
    "bidder",
    "second",
    "outsider",
    "archived",
  ]) {
    const id = (
      await db.query(
        `insert into auth.users(id,email) values(md5($1)::uuid,$1||'@sql-performance.invalid') returning id`,
        [name],
      )
    ).rows[0].id;
    const workspace = (
      await db.query("select id from public.workspaces where owner_id=$1", [id])
    ).rows[0].id;
    actors[name] = { id, workspace };
  }
  await db.exec("update public.profiles set approval_status='approved'");
  await db.query("update public.profiles set role='admin' where id=$1", [
    actors.admin.id,
  ]);
  for (const [name, owner] of [
    ["bidder", "owner"],
    ["second", "owner"],
    ["outsider", "outsider"],
    ["archived", "owner"],
  ]) {
    if (name !== "outsider")
      await db.query("update public.profiles set role='bidder' where id=$1", [
        actors[name].id,
      ]);
    actors[name].workspace = actors[owner].workspace;
    await db.query(
      "insert into public.bidders(user_id,workspace_id,default_rate_cents,archived) values($1,$2,125,$3)",
      [actors[name].id, actors[name].workspace, name === "archived"],
    );
    actors[name].profile = (
      await db.query(
        "insert into public.candidate_profiles(workspace_id,identifier,candidate_name,retention_months) values($1,$2,'Fixture candidate',null) returning id",
        [actors[name].workspace, `SQL-${name}`],
      )
    ).rows[0].id;
    actors[name].resume = (
      await db.query(
        "insert into public.resumes(workspace_id,bidder_id,profile_id,identifier,candidate_name,email,phone) values($1,$2,$3,$4,'Fixture candidate',$5,'555-0100') returning id",
        [
          actors[name].workspace,
          actors[name].id,
          actors[name].profile,
          `SQL-${name}`,
          `${name}@sql-performance.invalid`,
        ],
      )
    ).rows[0].id;
  }
  await db.exec(
    "select set_config('request.jwt.claim.role','service_role',false)",
  );
  for (const name of ["bidder", "second", "outsider", "archived"]) {
    const actor = actors[name];
    const n = name === "bidder" ? count : Math.min(count, 40);
    await db.query(
      `insert into public.bids(id,workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,source,arrangement,job_status,found_at,
      applied,application_method,rate_cents,applied_at,first_applied_at,review_status,review_revision,interview_scheduled,interview_tracking,rejected_hashes,deleted_at)
      select md5($4||'-bid-'||g)::uuid,$1,$2,$3,
        case when g%9=0 then 'Literal %_\\'||g else 'Company '||(g%21) end,'Role '||(g%7),'https://jobs.invalid/'||$4||'/'||g,'https://jobs.invalid/'||$4||'/'||g,
        case g%4 when 0 then '' when 1 then 'LinkedIn' when 2 then 'Board' else 'Other' end,
        case g%3 when 0 then 'remote' when 1 then 'onsite' else 'hybrid' end,
        case when g%5=0 then 'closed' else 'open' end,
        '2026-03-07 00:00Z'::timestamptz+(g%365)*interval '1 day'+(g%5)*interval '1 hour',
        g%2=0,case when g%2=0 then 'manual' end,case when g%2=0 then 100+g end,
        case when g%2=0 then '2026-03-08 00:00Z'::timestamptz+(g%365)*interval '1 day' end,
        case when g%2=0 then '2026-03-07 00:00Z'::timestamptz+(g%365)*interval '1 day' end,
        case when g%3=0 then 'pending' when g%3=1 then 'approved' else 'rejected' end,1,g%6=0,g%10<>0,
        array[repeat('a',64)],case when g%17=0 then now() end
      from generate_series(1,$5::integer) g`,
      [actor.workspace, actor.id, actor.resume, name, n],
    );
    // Upload guards require a currently approved revision. Capture the final
    // review states, temporarily approve insertion, then restore them.
    await db.query(
      "update public.bids set review_status='approved' where bidder_id=$1",
      [actor.id],
    );
    await db.query(
      `insert into public.files(id,workspace_id,bidder_id,kind,bid_id,filename,mime,size_bytes,storage_path,created_by,review_revision,finalized)
      select md5($4||'-file-'||g)::uuid,$1,$2,'screenshot',md5($4||'-bid-'||g)::uuid,'proof.png','image/png',
        100+(g%8)*10,$4||'/proof/'||g,$2,1,g%11<>0 from generate_series(1,$3::integer) g where g%3<>0 and g%17<>0`,
      [actor.workspace, actor.id, n, name],
    );
    await db.query(
      `update public.bids b set evidence_file_id=f.id from public.files f where f.bid_id=b.id and b.bidder_id=$1`,
      [actor.id],
    );
    await db.query(
      `update public.bids set review_status=case when split_part(url,'/',5)::int%3=0 then 'pending' when split_part(url,'/',5)::int%3=1 then 'approved' else 'rejected' end where bidder_id=$1`,
      [actor.id],
    );
  }
  // A valid FK with wrong current-file identity must never expose byte metadata.
  await db.query(
    "update public.bids set evidence_file_id=md5('outsider-file-1')::uuid where id=md5('bidder-bid-1')::uuid",
  );
  await db.exec("analyze; set work_mem='2MB'");
  return { db, actors };
}

export async function asActor(db, actors, name, service = false) {
  await db.exec(
    `reset role; set role ${service ? "service_role" : "authenticated"}`,
  );
  await db.query(
    "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false)",
    [name ? actors[name].id : "", service ? "service_role" : "authenticated"],
  );
}

export async function definition(db, signature) {
  return (
    await db.query("select pg_get_functiondef($1::regprocedure) definition", [
      signature,
    ])
  ).rows[0].definition;
}

export async function apply(db, file) {
  await db.exec("reset role");
  await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
}

export function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
