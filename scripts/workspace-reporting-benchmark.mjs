// Synthetic, local-only before/after benchmark. Never connects to hosted data.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { createFixture, asActor } from "../tests/helpers/sql-performance-fixture.mjs";

const count = Number(process.env.BENCHMARK_BIDS ?? 22456);
if (!Number.isSafeInteger(count) || count < 100 || count > 100000) throw new Error("BENCHMARK_BIDS must be 100–100000");
const { db, actors } = await createFixture(count);
const evidence = { checkedAt: new Date().toISOString(), environment: "local PGlite", requestedPrimaryBids: count, reference: "22,456 is twice the 11,228 historical production count in docs/reporting-performance.md; current hosted count has not been re-measured", limitations: "Five queued readers share one embedded database. This is not hosted parallel-connection, Vercel CPU, or billing evidence.", baseline: {}, candidate: {}, parity: true };
const migrations = readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).sort();
const percentile = values => [...values].sort((a,b) => a-b)[Math.ceil(values.length * .95) - 1];
async function measure() {
  const results = {};
  for (const actor of ["owner", "admin", "bidder"]) {
    await asActor(db, actors, actor);
    for (const bounded of [false, true]) {
      const sql = bounded ? "select public.dashboard_performance_v2(current_date-6,current_date,$1,null,null) value" : "select public.dashboard_performance_v2(null,null,$1,null,null) value";
      const args = [actors.owner.workspace];
      const first = (await db.query(sql,args)).rows[0].value;
      const samples = [];
      for (let burst=0;burst<4;burst++) await Promise.all(Array.from({length:5},async()=> {
        const start=performance.now(); await db.query(sql,args); samples.push(performance.now()-start);
      }));
      results[`${actor}:${bounded?"week":"all"}`] = { p95Ms: Math.round(percentile(samples)*100)/100, responseBytes: Buffer.byteLength(JSON.stringify(first)), value:first };
    }
  }
  await db.exec("reset role");
  const original=(await db.query("select arrangement from public.bids where id=md5('bidder-bid-1')::uuid")).rows[0].arrangement;
  const samples=[];
  for (let n=0;n<30;n++) {
    const start=performance.now();
    await db.query("update public.bids set arrangement=$1 where id=md5('bidder-bid-1')::uuid",[n%2?"remote":"hybrid"]);
    samples.push(performance.now()-start);
  }
  await db.query("update public.bids set arrangement=$1 where id=md5('bidder-bid-1')::uuid",[original]);
  results.rawUpdate = {p95Ms: Math.round(percentile(samples)*100)/100};
  await asActor(db,actors,"owner");
  const current=(await db.query("select id,version from public.bids where id=md5('bidder-bid-1')::uuid")).rows[0];
  const mutation=[];
  for(let n=0;n<30;n++) {
    const start=performance.now();
    const value=(await db.query("select public.update_bid_cell($1,'arrangement',$2,$3) value",[current.id,n%2?"remote":"hybrid",current.version])).rows[0].value;
    if(!value.ok) throw new Error("Expected successful versioned fixture mutation");
    current.version=value.row.version;mutation.push(performance.now()-start);
  }
  await db.exec("reset role");
  await db.query("update public.bids set arrangement=$1 where id=$2",[original,current.id]);
  results.write = {p95Ms: Math.round(percentile(mutation)*100)/100,operation:"authenticated update_bid_cell, including locks/version/validation/audit"};
  return results;
}
try {
  // The older differential fixture deliberately assigns one evidence file to
  // the wrong bid. Remove that adversarial link before retention's historical
  // timestamp backfill, which assumes valid current-file identity.
  await db.exec("update public.bids b set evidence_file_id=null where evidence_file_id is not null and not exists(select 1 from public.files f where f.id=b.evidence_file_id and f.bid_id=b.id and f.workspace_id=b.workspace_id and f.bidder_id=b.bidder_id)");
  for (const file of migrations.filter(file => file > "202610130019_review_correctness.sql" && file < "202610310001_workspace_report_storage.sql")) await db.exec(readFileSync(`supabase/migrations/${file}`,"utf8"));
  const resumeFile=(await db.query("insert into public.files(workspace_id,bidder_id,kind,resume_id,filename,mime,size_bytes,storage_path,created_by,finalized) values($1,$2,'resume',$3,'fixture.pdf','application/pdf',100,'benchmark/fixture.pdf',$2,true) returning id",[actors.owner.workspace,actors.bidder.id,actors.bidder.resume])).rows[0].id;
  await db.query("update public.resumes set file_id=$1 where id=$2",[resumeFile,actors.bidder.resume]);
  evidence.actualBids=Number((await db.query("select count(*) n from public.bids")).rows[0].n);
  evidence.baseline = await measure();
  for (const file of migrations.filter(file => file >= "202610310001_workspace_report_storage.sql")) await db.exec(readFileSync(`supabase/migrations/${file}`,"utf8"));
  evidence.candidate=await measure();
  for (const key of Object.keys(evidence.baseline).filter(key=>!(["write","rawUpdate"].includes(key)))) {
    if (!isDeepStrictEqual(evidence.baseline[key].value,evidence.candidate[key].value)) evidence.parity=false;
    delete evidence.baseline[key].value; delete evidence.candidate[key].value;
  }
  evidence.reconciliationDifferences=Number((await db.query("select private.reconcile_bid_report_daily() n")).rows[0].n);
  evidence.writeP95ChangePercent=Math.round((evidence.candidate.write.p95Ms/evidence.baseline.write.p95Ms-1)*1000)/10;
  evidence.localReadTargetMet=Object.entries(evidence.candidate).filter(([key])=>!(["write","rawUpdate"].includes(key))).every(([,value])=>value.p95Ms<2000);
  evidence.localWriteTargetMet=evidence.writeP95ChangePercent<=20;
  mkdirSync("docs/release-evidence",{recursive:true});
  writeFileSync("docs/release-evidence/2026-10-31-workspace-reporting-benchmark.json",JSON.stringify(evidence,null,2)+"\n");
  console.log(JSON.stringify(evidence,null,2));
  if (!evidence.parity || evidence.reconciliationDifferences || !evidence.localReadTargetMet || !evidence.localWriteTargetMet) process.exitCode=1;
} catch (error) {
  console.error(JSON.stringify({ code: error.code, error: error.message })); process.exitCode=1;
} finally { await db.close(); }
