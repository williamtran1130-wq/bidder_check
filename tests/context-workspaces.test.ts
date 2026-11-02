import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const state=vi.hoisted(()=>({rows:[] as Record<string,unknown>[],selects:[] as string[]}));
vi.mock("@/lib/server",()=>({createClient:async()=>({rpc:async()=>({error:null}),auth:{getUser:async()=>({data:{user:{id:"viewer"}}})},from(table:string){
 const query={select(columns:string){state.selects.push(table+":"+columns);return query;},eq(){return query;},order(){return query;},overrideTypes(){return query;},limit(){return query;},single:async()=>({data:{id:"viewer",role:"admin",archived:false,approval_status:"approved"},error:null}),then(resolve:(value:unknown)=>unknown){return Promise.resolve({data:state.rows,error:null}).then(resolve);}};
 return query;
}})}));
import {getContext} from "@/lib/auth";
beforeEach(()=>{state.rows=[];state.selects=[];});
it("retains archived-owner workspace history while excluding it from normal workspace options",async()=>{
 state.rows=[{id:"active",owner_id:"owner",name:"Active",owner:{archived:false}},{id:"inactive",owner_id:"old-owner",name:"Old",owner:{archived:true}}];
 const context=await getContext();
 expect(context.workspaces.map(row=>row.id)).toEqual(["active","inactive"]);
 expect(context.selectableWorkspaces.map(row=>row.id)).toEqual(["active"]);
 expect(context.workspaces[0]).not.toHaveProperty("owner");
 expect(state.selects).toHaveLength(3);
});
it("does not hide an authorized workspace when RLS omits its owner metadata",async()=>{
 state.rows=[{id:"authorized",owner_id:"private-owner",name:"Authorized",owner:null}];
 expect((await getContext()).selectableWorkspaces.map(row=>row.id)).toEqual(["authorized"]);
});
