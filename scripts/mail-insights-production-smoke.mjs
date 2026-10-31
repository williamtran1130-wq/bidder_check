// Explicit synthetic production acceptance for the authorized mail Insights release.
// No email is sent; only accounts and rows created by this script are removed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "@playwright/test";
import { formatInTimeZone } from "date-fns-tz";

assert.ok(process.argv.includes("--production"), "Explicit --production required");
const url=process.env.NEXT_PUBLIC_SUPABASE_URL;
assert.equal(url,"https://aizorlyfggwbewetnwqm.supabase.co");
const origin="https://bidder-check.vercel.app";
const options={auth:{persistSession:false,autoRefreshToken:false}};
const admin=createClient(url,process.env.SUPABASE_SECRET_KEY,options);
const key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const ids=[], clients=[], checks=[];
let workspaceIds=[], browser;
const prefix=`mail-insights-smoke-${randomUUID()}`;
const password=`Smoke-${randomUUID()}!`;
const ok=result=>{if(result.error)throw new Error(result.error.message);return result.data};
function pass(message){checks.push(message);console.log("PASS "+message)}
async function api(path,token,init={}) {
 return fetch(origin+path,{...init,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...init.headers}});
}
try {
 const config=await api("/api/mail-insights/config");assert.equal(config.status,200);
 const publicConfig=await config.json();assert.equal(publicConfig.supabase_url,url);assert.equal(publicConfig.app_url,origin);
 assert.deepEqual(Object.keys(publicConfig).sort(),["app_url","publishable_key","supabase_url"]);pass("public connection config contains only expected public fields");
 assert.equal((await api("/api/mail-insights/snapshot",null,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).status,401);
 pass("unauthenticated uploads return JSON 401 without a login redirect");
 for(const label of ["owner","other","bidder"]) {
  const email=`${prefix}-${label}@example.com`;
  const {user}=ok(await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{display_name:`Insights smoke ${label}`}}));
  ids.push(user.id);
  ok(await admin.from("profiles").update({approval_status:"approved"}).eq("id",user.id));
  const client=createClient(url,key,options);
  const session=ok(await client.auth.signInWithPassword({email,password})).session;
  clients.push({client,email,id:user.id,token:session.access_token});
 }
 workspaceIds=ok(await admin.from("workspaces").select("id").in("owner_id",ids)).map(row=>row.id);
 const ownerWorkspace=ok(await admin.from("workspaces").select("id").eq("owner_id",ids[0]).single()).id;
 ok(await admin.from("profiles").update({role:"bidder"}).eq("id",ids[2]));
 ok(await admin.from("bidders").insert({user_id:ids[2],workspace_id:ownerWorkspace}));
 const profile=ok(await clients[0].client.rpc("save_candidate_profile",{p_id:null,p_workspace:ownerWorkspace,p_identifier:"INSIGHTS-SMOKE",p_name:"Synthetic candidate",p_address:"",p_links:"",p_instructions:""}));
 const assignment=ok(await clients[0].client.rpc("save_resume_assignment",{p_id:null,p_profile:profile,p_bidder:ids[2],p_email:"synthetic-mailbox@example.com",p_phone:"555-0000",p_file:null,p_rate:null}));
 const localRoot=resolve("../mail-check/mail-check");
 const python=resolve(localRoot,".venv/Scripts/python.exe");
 const pythonCode=`import json,tempfile
from pathlib import Path
from datetime import datetime,timezone
from mailcheck import db,bidder_check
from mailcheck.models import NormalizedMessage,Classification
import os
class Store:
 def __init__(self): self.values={}
 def get_password(self,s,k): return self.values.get((s,k))
 def set_password(self,s,k,v): self.values[(s,k)]=v
 def delete_password(self,s,k): self.values.pop((s,k),None)
with tempfile.TemporaryDirectory() as temp:
 path=Path(temp)/'synthetic.db'
 conn=db.connect(path)
 a=db.add_account(conn,label='Synthetic primary',email='synthetic-mailbox@example.com')
 other=db.add_account(conn,label='Synthetic private',email='unassigned-private@example.com')
 for account in (a,other):
  for number in range(3):
   pk=db.upsert_message(conn,NormalizedMessage(account_id=account,account_label='Synthetic',message_id=str(number),uid=str(number),folder='INBOX',from_addr='synthetic@example.com',from_name='Synthetic',subject='Synthetic smoke only',date_utc=datetime.now(timezone.utc),body='Synthetic smoke only'))
   db.save_classification(conn,pk,Classification(category='application_ack',action_required=False),'synthetic','v1')
 conn.close()
 publisher=bidder_check.Publisher(path,credential_store=Store())
 publisher.login(os.environ['SMOKE_ORIGIN'],os.environ['SMOKE_EMAIL'],os.environ['SMOKE_PASSWORD'])
 publisher.settings(True,[a,other])
 publisher.queue_current()
 publisher.tick()
 status=publisher.status()
 assert status['last_uploaded_at'],status.get('error')
 assert status['enabled']
 publisher.logout()
 publisher.close()
 print('Local Python login/export/upload/logout succeeded')`;
 const child=spawnSync(python,["-c",pythonCode],{cwd:localRoot,env:{...process.env,SMOKE_ORIGIN:origin,SMOKE_EMAIL:clients[0].email,SMOKE_PASSWORD:password},encoding:"utf8",timeout:120000});
 if(child.status!==0)throw new Error(`Local publisher smoke failed: ${child.stderr || child.error || child.stdout}`);
 pass("real local Python publisher signs in, exports metrics, uploads via production API and signs out");
 const today=formatInTimeZone(new Date(),"America/Chicago","yyyy-MM-dd");
 const readPath=`/api/mail-insights/report?from=${today}&to=${today}`;
 const ownerResponse=await api(readPath,clients[0].token);assert.equal(ownerResponse.status,200);
 const owner=await ownerResponse.json();assert.equal(owner.status,"ready");assert.equal(owner.mailboxes.length,2);
 assert.equal(owner.mailboxes.flatMap(m=>m.rows).reduce((n,row)=>n+row.count,0),6);
 assert.ok(!JSON.stringify(owner).includes("Synthetic smoke only"));
 pass("owner report returns complete aggregate cubes without message contents");
 const other=await(await api(readPath,clients[1].token)).json();assert.equal(other.status,"not_synced");assert.equal(other.mailboxes.length,0);
 const bidderResponse=await api(readPath,clients[2].token);assert.equal(bidderResponse.status,200);
 const bidder=await bidderResponse.json();assert.deepEqual(bidder.mailboxes.map(row=>row.email),["synthetic-mailbox@example.com"]);
 assert.ok(!JSON.stringify(bidder).includes("unassigned-private@example.com"));
 pass("other client and bidder projections enforce tenant and mailbox isolation");
 const wrong={schema_version:1,client_id:ids[1],revision:9,generated_at:new Date().toISOString(),timezone:"America/Chicago",mailboxes:[]};
 assert.equal((await api("/api/mail-insights/snapshot",clients[0].token,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(wrong)})).status,403);
 pass("a valid token cannot substitute a different client ID");
 browser=await chromium.launch();
 const context=await browser.newContext();const page=await context.newPage();
 await page.goto(origin+"/auth/login");
 await page.getByLabel("Email address",{exact:true}).fill(clients[0].email);
 await page.getByLabel("Password",{exact:true}).fill(password);
 await page.getByRole("button",{name:"Sign in",exact:true}).click();
 await page.waitForURL("**/dashboard",{timeout:60000});
 await page.getByRole("heading",{name:"Email insights",exact:true}).waitFor({timeout:60000});
 await page.getByRole("heading",{name:"Bids and email activity",exact:true}).waitFor();
 await page.getByRole("tab",{name:"Profile",exact:true}).click();
 await page.getByRole("tabpanel",{name:"Activity by profile"}).getByText("INSIGHTS-SMOKE",{exact:true}).waitFor({timeout:30000});
 await mkdir("test-results",{recursive:true});
 await page.screenshot({path:"test-results/mail-insights-production.png",fullPage:true});
 pass("production Overview renders stored mail metrics and profile comparison after ordinary website sign-in");
 ok(await clients[0].client.rpc("archive_resume_assignment",{p_id:assignment,p_archived:true}));
 const revoked=await(await api(readPath,clients[2].token)).json();assert.equal(revoked.mailboxes.length,0);
 pass("archiving the assignment immediately removes bidder mailbox visibility");
} finally {
 await browser?.close();
 for(const row of clients)await row.client.auth.signOut({scope:"local"}).catch(()=>{});
 if(ids.length) {
  workspaceIds=ok(await admin.from("workspaces").select("id").in("owner_id",ids)).map(row=>row.id);
  if(workspaceIds.length) {
   for(const table of ["mail_insights_state","resumes","invitations","bidders","candidate_profiles"])
    ok(await admin.from(table).delete().in("workspace_id",workspaceIds));
   ok(await admin.from("workspaces").delete().in("id",workspaceIds));
  }
  ok(await admin.from("profiles").delete().in("id",ids));
  for(const id of ids)ok(await admin.auth.admin.deleteUser(id));
 }
 await mkdir("test-results",{recursive:true});
 await writeFile("test-results/mail-insights-production.json",JSON.stringify({at:new Date().toISOString(),origin,checks,synthetic_accounts_removed:ids.length},null,2));
 console.log(`Synthetic production cleanup complete (${ids.length} accounts).`);
}
