import { beforeEach, expect, it, vi } from "vitest";
const h=vi.hoisted(()=>({user:{id:"10000000-0000-4000-8000-000000000001"} as {id:string}|null,profile:{role:"client",archived:false,approval_status:"approved"},authError:null as {name:string;status?:number}|null,error:null as {code:string}|null,result:{ok:true},calls:[] as string[]}));
vi.mock("server-only",()=>({}));
vi.mock("@supabase/supabase-js",()=>({createClient:(_url:unknown,_key:unknown,options:{global:{headers:{Authorization:string}}})=>{
 h.calls.push(options.global.headers.Authorization);
 return {auth:{getUser:async(token:string)=>{h.calls.push("getUser:"+token);return {data:{user:h.user},error:h.authError}}},from:()=>({select:()=>({eq:()=>({single:async()=>({data:h.profile,error:null})})})}),rpc:async(name:string)=>{h.calls.push(name);return {data:h.result,error:h.error}}};
}}));
vi.mock("@/lib/auth",()=>({getActor:async()=>{throw new Error("Cookie authentication must not be used for uploads")}}));
import { POST } from "@/app/api/mail-insights/snapshot/route";
import { GET as connection } from "@/app/api/mail-insights/connection/route";
import { GET as configuration } from "@/app/api/mail-insights/config/route";
const uid="10000000-0000-4000-8000-000000000001";
const body=()=>({schema_version:1,client_id:uid,revision:1,generated_at:new Date().toISOString(),timezone:"America/Chicago",mailboxes:[]});
const request=(data:unknown,token=true)=>new Request("https://bidder-check.vercel.app/api/mail-insights/snapshot",{method:"POST",headers:{"Content-Type":"application/json",...(token?{Authorization:"Bearer valid-token"}:{Cookie:"web-session=ignored"})},body:JSON.stringify(data)});
beforeEach(()=>{h.user={id:uid};h.profile={role:"client",archived:false,approval_status:"approved"};h.authError=null;h.error=null;h.result={ok:true};h.calls=[];process.env.NEXT_PUBLIC_SUPABASE_URL="https://test.supabase.co";process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="public-key";process.env.APP_URL="https://bidder-check.vercel.app"});
it("requires bearer authentication even when a website cookie is present",async()=>{
 expect((await POST(request(body(),false))).status).toBe(401);
 expect(h.calls).toEqual([]);
});
it("verifies the token remotely and passes only the caller JWT to the ingestion RPC",async()=>{
 const result=await POST(request(body()));
 expect(result.status).toBe(200);
 expect(h.calls).toEqual(["Bearer valid-token","getUser:valid-token","ingest_mail_insights"]);
 expect(result.headers.get("cache-control")).toContain("no-store");
});
it("rejects client identity substitution and inactive/nonclient uploaders",async()=>{
 expect((await POST(request({...body(),client_id:"10000000-0000-4000-8000-000000000002"}))).status).toBe(403);
 for (const role of ["bidder","admin"]) {h.profile.role=role;expect((await POST(request(body()))).status).toBe(403)}
 h.profile.role="client";h.profile.archived=true;expect((await POST(request(body()))).status).toBe(403);
 expect(h.calls).not.toContain("ingest_mail_insights");
});
it("rejects forbidden message fields and oversized bodies before database ingestion",async()=>{
 expect((await POST(request({...body(),subject:"PRIVATE"}))).status).toBe(400);
 expect((await POST(request({...body(),mailboxes:[],extra:"x".repeat(2100000)}))).status).toBe(413);
 expect(h.calls).not.toContain("ingest_mail_insights");
});
it("returns revision conflicts as 409 and never exposes arbitrary database errors",async()=>{
 h.result={code:"revision_conflict",last_revision:12} as unknown as typeof h.result;
 expect((await POST(request(body()))).status).toBe(409);
 h.error={code:"XX001"};
 const failed=await POST(request(body()));expect(failed.status).toBe(503);expect(await failed.text()).not.toContain("XX001");
});
it("requires bearer for connection identity and exposes only public configuration",async()=>{
 expect((await connection(new Request("https://example.test/api/mail-insights/connection"))).status).toBe(401);
 const response=await configuration();expect(await response.json()).toEqual({supabase_url:"https://test.supabase.co",publishable_key:"public-key",snapshot_versions:[1,2],app_url:"https://bidder-check.vercel.app"});
});
it("keeps transient Auth outages retryable instead of expiring a healthy publisher session",async()=>{
 for(const error of [{name:"AuthRetryableFetchError",status:503},{name:"AuthApiError",status:429}]) {
  h.authError=error;expect((await POST(request(body()))).status).toBe(503);
 }
 h.authError={name:"AuthApiError",status:401};
 expect((await POST(request(body()))).status).toBe(401);
 expect(h.calls).not.toContain("ingest_mail_insights");
});
