// Disposable local PGlite only; never reads environment files or contacts a host.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  asActor,
  createFixture,
  definition,
  apply,
  median,
} from "./sql-performance-fixture.mjs";

const plansOnly = process.argv[4] === "plans-only";
const count = Number(process.argv[2] ?? 25000);
const label = process.argv[3] ?? "final";
if (
  !Number.isInteger(count) ||
  count < 100 ||
  count > 100000 ||
  !/^[a-z0-9-]+$/.test(label)
)
  throw new Error("Use 100..100000 rows and a lowercase label");
const directory = `test-results/improvements/sql-performance/local-${count}-${label}`;
const backup = `.superpowers/sdd/2026-10-13-feature-preserving-improvements/sql-performance/local-${count}-${label}`;
for (const path of [directory, backup]) mkdirSync(path, { recursive: true });
const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const report = {
  started: new Date().toISOString(),
  finished: false,
  engine: "local PGlite",
  primaryBidRows: count,
  otherBidRows: 120,
  samplesPerVariant: 5,
  labels: {
    latency:
      "Five local medians; each variant reinstalled before RPC; compilation included. Not hosted p95.",
    write:
      "Alternating index state, transaction rollback and VACUUM ANALYZE outside timing between samples.",
    plans:
      "Operator work captured separately; no plan timing used as latency acceptance.",
  },
  workMem: "2MB",
  raw: {},
  plans: {},
  definitionHashes: {},
};
function save() {
  for (const path of [directory, backup])
    writeFileSync(`${path}/measurements.json`, JSON.stringify(report, null, 2));
}
save();
console.log(`Seeding ${count} bids + 120 role/visibility rows`);
const { db, actors } = await createFixture(count);
const migrations = [
  "202610130020_scoped_counts_delete_indexes.sql",
  "202610130023_ordinary_list_page.sql",
  "202610130024_dashboard_branch_groups.sql",
  "202610130025_reviewed_import_sets.sql",
];
const signatures = {
  counts: "public.resume_bid_counts()",
  list: "public.list_bids_v2(jsonb)",
  dashboard: "private.dashboard_report_events(date,date,uuid,uuid,uuid)",
  imports: "public.import_bids_reviewed(uuid,date,jsonb,integer[],uuid)",
};
const before = {},
  after = {};
for (const [name, signature] of Object.entries(signatures))
  before[name] = await definition(db, signature);
for (const file of migrations) {
  await apply(db, file);
  report.definitionHashes[file] = hash(
    readFileSync(`supabase/migrations/${file}`, "utf8"),
  );
}
for (const [name, signature] of Object.entries(signatures))
  after[name] = await definition(db, signature);
report.fixture = {
  actors,
  baselineHashes: Object.fromEntries(
    Object.entries(before).map(([name, body]) => [name, hash(body)]),
  ),
};
await db.exec("reset role");
await db.query(
  "insert into public.files(workspace_id,bidder_id,kind,resume_id,filename,mime,size_bytes,storage_path,created_by,finalized) select $1,$2,'resume',$3,'orphan.pdf','application/pdf',100,'performance-delete/'||g,$4,true from generate_series(1,500) g",
  [
    actors.bidder.workspace,
    actors.bidder.id,
    actors.bidder.resume,
    actors.owner.id,
  ],
);
report.orphanResumeFilesForDeleteProbe = 500;
const request = "26000000-0000-4000-8000-000000000001";
await db.exec("reset role");
const fileId = (
  await db.query(
    `insert into public.files(workspace_id,bidder_id,kind,resume_id,filename,mime,size_bytes,storage_path,created_by,finalized) values($1,$2,'resume',$3,'resume.pdf','application/pdf',100,'performance/resume.pdf',$4,true) returning id`,
    [
      actors.bidder.workspace,
      actors.bidder.id,
      actors.bidder.resume,
      actors.owner.id,
    ],
  )
).rows[0].id;
await db.query("update public.resumes set file_id=$1 where id=$2", [
  fileId,
  actors.bidder.resume,
]);
const imports = Array.from({ length: 500 }, (_, i) => ({
  company: `Perf import ${i}`,
  role_name: "Engineer",
  url: `https://perf-import.invalid/${i}?utm_source=ignored`,
  source: "Perf import",
  arrangement: "remote",
  job_status: "open",
}));
const sources = imports.map((_, i) => 1000 - i);
const importSql =
  "select public.import_bids_reviewed($1,'2026-01-01',$2,$3,$4) result";
const importParams = [
  actors.bidder.resume,
  JSON.stringify(imports),
  sources,
  request,
];
async function rpc(def, actor, sql, params = []) {
  await db.exec(`reset role;${def}`);
  await asActor(db, actors, actor);
  const start = performance.now();
  const rows = (await db.query(sql, params)).rows;
  return { ms: performance.now() - start, digest: hash(rows) };
}
async function pair(name, defName, actor, sql, params = []) {
  const samples = { before: [], after: [], digests: [] };
  report.raw[name] = samples;
  for (let i = 0; i < 5; i++) {
    const results = {};
    for (const version of i % 2 ? ["after", "before"] : ["before", "after"]) {
      results[version] = await rpc(
        (version === "before" ? before : after)[defName],
        actor,
        sql,
        params,
      );
      samples[version].push(results[version].ms);
    }
    if (results.before.digest !== results.after.digest)
      throw new Error(`Full output mismatch: ${name}`);
    samples.digests.push(results.before.digest);
    save();
  }
  samples.medianMs = {
    before: median(samples.before),
    after: median(samples.after),
  };
  save();
  console.log(name, samples.medianMs);
}
const cases = [
  [
    "counts-owner",
    "counts",
    "owner",
    "select public.resume_bid_counts() result",
  ],
  [
    "counts-bidder",
    "counts",
    "bidder",
    "select public.resume_bid_counts() result",
  ],
  ["list-owner-first", "list", "owner", { pageSize: 25 }],
  ["list-owner-deep", "list", "owner", { pageSize: 25, pageIndex: 400 }],
  [
    "list-owner-pending",
    "list",
    "owner",
    { pageSize: 25, status: "pending_review" },
  ],
  [
    "list-owner-literal",
    "list",
    "owner",
    { pageSize: 25, search: "Literal %_\\" },
  ],
  [
    "list-owner-selective",
    "list",
    "owner",
    { pageSize: 25, search: "Company 1" },
  ],
  [
    "list-owner-ctday",
    "list",
    "owner",
    {
      pageSize: 25,
      columnFilters: { found_at: { from: "2026-03-08", to: "2026-03-08" } },
    },
  ],
  [
    "list-owner-scoped",
    "list",
    "owner",
    { pageSize: 25, scopeBidderId: actors.bidder.id },
  ],
  [
    "list-owner-repeated",
    "list",
    "owner",
    { pageSize: 25, columnFilters: { screenshot: "Repeated sizes only" } },
  ],
  [
    "list-owner-size-sort",
    "list",
    "owner",
    { pageSize: 25, sorting: [{ id: "screenshot_size_bytes", desc: false }] },
  ],
  ["list-bidder-first", "list", "bidder", { pageSize: 25 }],
  [
    "dashboard-owner-all",
    "dashboard",
    "owner",
    "select public.dashboard_performance_v2(null,null,null,null,null) result",
  ],
  [
    "dashboard-owner-ctday",
    "dashboard",
    "owner",
    "select public.dashboard_performance_v2('2026-03-08','2026-03-08',null,null,null) result",
  ],
  [
    "dashboard-bidder-all",
    "dashboard",
    "bidder",
    "select public.dashboard_performance_v2(null,null,null,null,null) result",
  ],
];

async function setIndexes(enabled) {
  await db.exec("reset role");
  if (enabled) await apply(db, migrations[0]);
  else
    for (const name of [
      "files_bid_delete_lookup",
      "files_resume_delete_lookup",
      "bids_evidence_delete_lookup",
      "bid_events_file_delete_lookup",
    ])
      await db.exec(`drop index if exists public.${name}`);
  await db.exec("vacuum analyze");
}
async function rollbackWork(kind) {
  await db.exec("reset role;begin");
  await db.query(
    "select set_config('request.jwt.claim.role','service_role',false)",
  );
  let response;
  try {
    const start = performance.now();
    if (kind === "delete500")
      await db.query(
        "delete from public.files where storage_path like 'performance-delete/%'",
      );
    else if (kind === "write500") {
      await db.query(
        `insert into public.bids(id,workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,arrangement,review_status,review_revision) select md5('performance-write-'||g)::uuid,$1,$2,$3,'Write '||g,'Engineer','https://performance-write.invalid/'||g,'https://performance-write.invalid/'||g,'remote','approved',1 from generate_series(1,500) g`,
        [actors.bidder.workspace, actors.bidder.id, actors.bidder.resume],
      );
      await db.query(
        `insert into public.files(id,workspace_id,bidder_id,bid_id,kind,filename,mime,size_bytes,storage_path,created_by,review_revision,finalized) select md5('performance-file-'||g)::uuid,$1,$2,md5('performance-write-'||g)::uuid,'screenshot','proof.png','image/png',100,'performance-write/'||g,$2,1,true from generate_series(1,500) g`,
        [actors.bidder.workspace, actors.bidder.id],
      );
      await db.exec(
        `update public.bids set evidence_file_id=md5('performance-file-'||split_part(url,'/',4))::uuid where url like 'https://performance-write.invalid/%'`,
      );
      await db.query(
        `insert into public.bid_events(bid_id,actor_id,event,file_id) select md5('performance-write-'||g)::uuid,$1,'performance_write',md5('performance-file-'||g)::uuid from generate_series(1,500) g`,
        [actors.bidder.id],
      );
    } else {
      await asActor(db, actors, "bidder");
      response = (await db.query(importSql, importParams)).rows[0].result;
    }
    return {
      ms: performance.now() - start,
      response: response
        ? { ...response, ids: response.ids.length }
        : undefined,
    };
  } finally {
    await db.exec("rollback;reset role");
  }
}
try {
  if (!plansOnly) {
    console.log("Index write/delete/import tradeoff");
    await db.exec(`reset role;${before.imports}`);
    for (const kind of ["delete500", "write500", "import500"]) {
      const samples = { before: [], after: [], digests: [] };
      report.raw[`index-${kind}`] = samples;
      for (let i = 0; i < 5; i++) {
        const result = {};
        for (const version of i % 2
          ? ["after", "before"]
          : ["before", "after"]) {
          await setIndexes(version === "after");
          result[version] = await rollbackWork(kind);
          samples[version].push(result[version].ms);
        }
        if (kind === "import500") {
          if (hash(result.before.response) !== hash(result.after.response))
            throw new Error("Index import response mismatch");
          samples.digests.push(hash(result.before.response));
        }
        save();
      }
      samples.medianMs = {
        before: median(samples.before),
        after: median(samples.after),
      };
      save();
      console.log(`index-${kind}`, samples.medianMs);
    }
    await setIndexes(true);
    for (const [name, defName, actor, sqlOrQuery] of cases)
      await pair(
        name,
        defName,
        actor,
        typeof sqlOrQuery === "string"
          ? sqlOrQuery
          : "select public.list_bids_v2($1::jsonb) result",
        typeof sqlOrQuery === "string" ? [] : [JSON.stringify(sqlOrQuery)],
      );
    console.log("Import rewrite");
    const samples = { before: [], after: [], digests: [] };
    report.raw["import500-rewrite"] = samples;
    for (let i = 0; i < 5; i++) {
      const result = {};
      for (const version of i % 2 ? ["after", "before"] : ["before", "after"]) {
        await db.exec(
          `reset role;${(version === "before" ? before : after).imports}`,
        );
        await db.exec("vacuum analyze");
        result[version] = await rollbackWork("import500");
        samples[version].push(result[version].ms);
      }
      if (hash(result.before.response) !== hash(result.after.response))
        throw new Error("Import rewrite response mismatch");
      samples.digests.push(hash(result.before.response));
      save();
    }
    samples.medianMs = {
      before: median(samples.before),
      after: median(samples.after),
    };
    save();
    console.log("import500-rewrite", samples.medianMs);
  } else {
    report.labels.latency =
      "No latency measurements: scoped operator plans under possible concurrent local load.";
  }
  // Capture real catalog SELECTs with the same locals as the RPC. The static
  // gate selects the retained branch for broad managers or selective text/date.
  for (const version of ["before", "after"]) {
    await db.exec(
      `reset role;${(version === "before" ? before : after).list};${(version === "before" ? before : after).dashboard}`,
    );
    for (const [name, query] of [
      ["owner-first", { pageSize: 25 }],
      ["owner-pending", { pageSize: 25, status: "pending_review" }],
      [
        "owner-ctday",
        {
          pageSize: 25,
          columnFilters: { found_at: { from: "2026-03-08", to: "2026-03-08" } },
        },
      ],
    ]) {
      await asActor(db, actors, "owner");
      const body = (
        await db.query(
          "select prosrc from pg_proc where oid='public.list_bids_v2(jsonb)'::regprocedure",
        )
      ).rows[0].prosrc;
      const start =
        version === "after" && name !== "owner-pending"
          ? body.lastIndexOf("with filtered as not materialized")
          : body.indexOf("with filtered as not materialized");
      let sql = body.slice(start, body.indexOf(" into result;", start));
      const locals = {
        p_query: "($1::jsonb)",
        page_index: "0",
        page_size: "25",
        sort_id: "'found_at'",
        sort_desc: "true",
        columns: query.columnFilters
          ? `'${JSON.stringify(query.columnFilters)}'::jsonb`
          : "'{}'::jsonb",
        bidder_filter: "''",
        resume_filter: "''",
        bidder_matches: "null::uuid[]",
        resume_matches: "null::uuid[]",
        can_view_sizes: "true",
      };
      for (const [key, value] of Object.entries(locals))
        sql = sql.replace(new RegExp(`\\b${key}\\b`, "g"), () => value);
      const plan = (
        await db.query(`explain(analyze,buffers,format json) ${sql}`, [
          JSON.stringify(query),
        ])
      ).rows[0]["QUERY PLAN"];
      const file = `plan-${name}-${version}.json`;
      for (const path of [directory, backup])
        writeFileSync(`${path}/${file}`, JSON.stringify(plan, null, 2));
      report.plans[`${name}-${version}`] = file;
    }
    await asActor(db, actors, "owner");
    await db.exec("reset role");
    let sql = (
      await db.query(
        "select prosrc from pg_proc where oid='private.dashboard_report_events(date,date,uuid,uuid,uuid)'::regprocedure",
      )
    ).rows[0].prosrc;
    for (const [key, value] of Object.entries({
      p_from: "null::date",
      p_to: "null::date",
      p_workspace: "null::uuid",
      p_bidder: "null::uuid",
      p_profile: "null::uuid",
    }))
      sql = sql.replace(new RegExp(`\\b${key}\\b`, "g"), () => value);
    const plan = (await db.query(`explain(analyze,buffers,format json) ${sql}`))
      .rows[0]["QUERY PLAN"];
    const file = `plan-dashboard-${version}.json`;
    for (const path of [directory, backup])
      writeFileSync(`${path}/${file}`, JSON.stringify(plan, null, 2));
    report.plans[`dashboard-${version}`] = file;
  }
  report.finished = true;
  report.completed = new Date().toISOString();
  save();
  console.log(`Saved ${directory} and durable ${backup}`);
} finally {
  await db.close();
}
