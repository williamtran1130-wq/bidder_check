import { expect, it, vi, beforeEach } from 'vitest';
const h = vi.hoisted(()=>({ sessionError: null as {code:string;message:string}|null, user: {id:'user'} as {id:string}|null, profile: {id:'user',role:'client', archived:false, approval_status:'approved'}, workspaces:[{id:'workspace'}], calls:[] as string[] }));
vi.mock('server-only',()=>({}));
vi.mock('react',()=>({ cache: (fn:unknown)=>fn }));
vi.mock('next/navigation',()=>({ redirect:(url:string)=>{throw new Error('redirect:'+url)} }));
vi.mock('@/lib/server',()=>({createClient:async()=>({rpc:async()=>{h.calls.push('liveSession');return {error:h.sessionError}},auth:{getUser:async()=>{h.calls.push('getUser');return {data:{user:h.user}}}},from:(table:string)=>{
 const q={select:(columns:string)=>{h.calls.push(table+':'+columns);return q},eq:()=>q,single:async()=>({data:h.profile,error:null}),order:async()=>({data:h.workspaces,error:null}),limit:async()=>({data:h.workspaces,error:null})};return q;
}})}));
import * as auth from '@/lib/auth';
beforeEach(()=>{h.sessionError=null;h.calls=[];h.user={id:'user'};h.profile={id:'user',role:'client',archived:false,approval_status:'approved'};h.workspaces=[{id:'workspace'}]});
it('minimal actor checks fresh user without display/workspace list loading',async()=>{
 expect(auth).toHaveProperty('getActor');
 await auth.getActor();
 expect(h.calls).toEqual(['getUser','liveSession','profiles:id,role,approval_status,archived']);
});
it('rejects revoked sessions before loading protected data without treating an outage as revocation',async()=>{
 h.sessionError={code:'PT401',message:'expired'};
 await expect(auth.getActor()).rejects.toMatchObject({destination:'/auth/login'});
 expect(h.calls).not.toContain('profiles:id,role,approval_status,archived');
 h.sessionError={code:'08006',message:'database temporarily unavailable'};
 await expect(auth.getActor()).rejects.toThrow('temporarily unavailable');
});
it('live revocation and disabled bidder parent return explicit destinations',async()=>{
 expect(auth).toHaveProperty('getActor');
 h.user=null; await expect(auth.getActor()).rejects.toMatchObject({destination:'/auth/login'});
 h.user={id:'user'};h.profile.archived=true;await expect(auth.getActor()).rejects.toMatchObject({destination:'/auth/inactive'});
 h.profile.archived=false;h.profile.approval_status='pending';await expect(auth.getActor()).rejects.toMatchObject({destination:'/auth/approval'});
 h.profile.role='bidder';h.workspaces=[];await expect(auth.getActor()).rejects.toMatchObject({destination:'/auth/inactive'});
});
