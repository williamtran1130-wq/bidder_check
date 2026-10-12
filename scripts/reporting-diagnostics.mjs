// Read-only hosted reporting diagnostics. Never emits credentials or records.
import pg from "pg";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
const { Client } = pg;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is required");
const project = new URL(url).hostname.split(".")[0];
const timeout = Math.min(
  15000,
  Math.max(1000, Number(process.env.REPORT_TIMEOUT_MS ?? 8000)),
);
const benchmark = process.argv.includes("--benchmark");
const names = [
  "dashboard_performance_v2",
  "earnings_performance_v2",
  "interview_performance",
];
const output = {
  environment: process.env.REPORT_ENV_LABEL ?? "unspecified",
  checkedAt: new Date().toISOString(),
  readOnly: true,
  timeoutMs: timeout,
  rest: {},
  postgres: {},
};
function safeError(error) {
  return {
    code: error?.code ?? error?.cause?.code ?? error?.name ?? "unknown",
  };
}
async function request(
  path,
  options = {},
  key = process.env.SUPABASE_SECRET_KEY,
  jwt = key,
) {
  const start = performance.now();
  try {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: key,
        Authorization: `Bearer ${jwt}`,
        ...options.headers,
      },
      signal: AbortSignal.timeout(timeout),
    });
    let body;
    if (options.method !== "HEAD") {
      try {
        body = await response.json();
      } catch {}
    }
    return {
      status: response.status,
      durationMs: Math.round(performance.now() - start),
      code: body?.code,
      range: response.headers.get("content-range"),
    };
  } catch (error) {
    return {
      ...safeError(error),
      durationMs: Math.round(performance.now() - start),
    };
  }
}
if (process.env.SUPABASE_SECRET_KEY) {
  for (const table of [
    "bids",
    "retained_bid_daily_aggregates",
    "bidders",
    "resumes",
    "candidate_profiles",
  ])
    output.rest[`${table}Count`] = await request(
      `${table}?select=${table === "bidders" ? "user_id" : table === "retained_bid_daily_aggregates" ? "report_day" : "id"}`,
      { method: "HEAD", headers: { Prefer: "count=exact" } },
    );
  for (const name of names)
    output.rest[name] = await request(`rpc/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ p_from: null, p_to: null }),
    });
  output.rest.note =
    "Service-key report calls have no user identity. Access denied confirms function resolution; PGRST202 indicates it is absent from the exposed schema cache. No private response bodies are retained.";
} else output.rest.blocker = "No SUPABASE_SECRET_KEY available";
let connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString && process.env.SUPABASE_DB_PASSWORD) {
  const connection = new URL(
    `postgresql://postgres@db.${project}.supabase.co:5432/postgres`,
  );
  connection.password = process.env.SUPABASE_DB_PASSWORD;
  connectionString = connection.toString();
}
function client() {
  const connection = new URL(connectionString);
  const caFile = process.env.SUPABASE_DB_CA_FILE || connection.searchParams.get("sslrootcert");
  // node-postgres lets connection-string SSL options override the explicit SSL
  // object. Remove those overrides so every diagnostic verifies the server.
  for (const option of ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"])
    connection.searchParams.delete(option);
  return new Client({
    connectionString: connection.toString(),
    ssl: { rejectUnauthorized: true, ...(caFile ? { ca: readFileSync(caFile, "utf8") } : {}) },
    connectionTimeoutMillis: timeout,
    query_timeout: timeout + 2000,
  });
}
async function readTransaction(c, actor, fn) {
  await c.query("begin read only");
  try {
    await c.query(`set local statement_timeout = '${timeout}ms'`);
    await c.query("set local lock_timeout = '1000ms'");
    if (actor) {
      await c.query("set local role authenticated");
      await c.query(
        "select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",
        [actor],
      );
    }
    return await fn();
  } finally {
    await c.query("rollback");
  }
}
function call(name) {
  return `select public.${name}(null::date,null::date,null::uuid,null::uuid,null::uuid${name === "dashboard_performance_v2" ? "" : ",'bidder'::text"})`;
}
if (connectionString) {
  let c;
  try {
    c = client();
    await c.connect();
    const facts = await readTransaction(c, null, async () => ({
      functions: (
        await c.query(
          "select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname=any($1::text[])",
          [names],
        )
      ).rows.map((r) => r.proname),
      counts: (
        await c.query(
          "select relname, n_live_tup::bigint estimated_rows,n_dead_tup::bigint dead_rows from pg_stat_user_tables where schemaname='public' and relname=any($1::text[])",
          [["bids", "retained_bid_daily_aggregates", "resumes", "bidders"]],
        )
      ).rows,
      indexes: (
        await c.query(
          "select indexname from pg_indexes where schemaname='public' and tablename=any($1::text[]) order by indexname",
          [["bids", "retained_bid_daily_aggregates"]],
        )
      ).rows.map((r) => r.indexname),
      actors: (
        await c.query(
          "select distinct on(role) id,role from public.profiles where not archived and (role<>'client' or approval_status='approved') order by role,id",
        )
      ).rows,
    }));
    const { actors, ...safeFacts } = facts;
    output.postgres = { ...safeFacts };
    if (benchmark) {
      output.postgres.benchmark = [];
      for (const actor of actors) {
        for (const name of facts.functions) {
          // Earnings denial is expected for bidders; all other calls retain normal RLS/auth semantics.
          try {
            const plan = await readTransaction(
              c,
              actor.id,
              async () =>
                (
                  await c.query(
                    `explain (analyze,buffers,format json) ${call(name)}`,
                  )
                ).rows[0]["QUERY PLAN"][0],
            );
            const times = await Promise.all(
              Array.from({ length: 5 }, async () => {
                let concurrent;
                const start = performance.now();
                try {
                  concurrent = client();
                  await concurrent.connect();
                  await readTransaction(concurrent, actor.id, () =>
                    concurrent.query(call(name)),
                  );
                  return {
                    durationMs: Math.round(performance.now() - start),
                    ok: true,
                  };
                } catch (error) {
                  return {
                    durationMs: Math.round(performance.now() - start),
                    ...safeError(error),
                  };
                } finally {
                  if (concurrent) await concurrent.end().catch(() => {});
                }
              }),
            );
            output.postgres.benchmark.push({
              role: actor.role,
              rpc: name,
              planningMs: plan["Planning Time"],
              executionMs: plan["Execution Time"],
              outerPlan: plan.Plan["Node Type"],
              sharedHitBlocks: plan.Plan["Shared Hit Blocks"],
              sharedReadBlocks: plan.Plan["Shared Read Blocks"],
              fiveConcurrent: times,
            });
          } catch (error) {
            output.postgres.benchmark.push({
              role: actor.role,
              rpc: name,
              ...safeError(error),
            });
          }
        }
      }
    }
  } catch (error) {
    output.postgres = { ...output.postgres, blocker: safeError(error) };
  } finally {
    if (c) await c.end().catch(() => {});
  }
} else
  output.postgres.blocker =
    "No SUPABASE_DB_URL or SUPABASE_DB_PASSWORD available";
// JWT benchmark path supports environments with REST credentials but no direct Postgres access.
if (benchmark) {
  output.rest.authenticatedBenchmark = [];
  for (const role of ["ADMIN", "CLIENT", "BIDDER"]) {
    const jwt = process.env[`REPORT_${role}_JWT`];
    if (!jwt) continue;
    for (const name of names) {
      const payload = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ p_from: null, p_to: null }),
      };
      const times = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(
            `rpc/${name}`,
            payload,
            process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
            jwt,
          ),
        ),
      );
      output.rest.authenticatedBenchmark.push({
        role: role.toLowerCase(),
        rpc: name,
        fiveConcurrent: times,
      });
    }
  }
}
console.log(JSON.stringify(output, null, 2));
