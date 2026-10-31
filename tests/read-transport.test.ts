import { expect, it, vi, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
afterEach(()=>vi.unstubAllGlobals());
it('chooses read-only POST before issuing large filters and never falls back or retries',async()=>{
 expect(existsSync('src/lib/read-client.ts')).toBe(true);
 const fetcher=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>{void _input;void _init;return new Response(JSON.stringify({error:'Timeout',code:'statement_timeout'}),{status:200});});vi.stubGlobal('fetch',fetcher);
 const {getBidRows}=await import('@/lib/read-client');
 await getBidRows('all','','',false,undefined,{search:'',status:'all',arrangement:'all',resume:'all',bidder:'all',source:'all',job:'all',columnFilters:[{id:'company',value:Array(300).fill('company')}],sorting:[],pageIndex:0,pageSize:10});
 expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0][1]).toMatchObject({method:'POST',cache:'no-store',credentials:'same-origin'});
});
it('auth failure dispatches private-state reset and explicit login destination',async()=>{
 expect(existsSync('src/lib/read-client.ts')).toBe(true);
 const win=Object.assign(new EventTarget(),{location:{assign:vi.fn()}});vi.stubGlobal('window',win);
 const revoked=vi.fn();win.addEventListener('workspace-access-revoked',revoked);
 vi.stubGlobal('fetch',async()=>new Response(JSON.stringify({error:'Sign in',destination:'/auth/login'}),{status:401}));
 const {recentBidPurges}=await import('@/lib/read-client');await recentBidPurges();
 expect(revoked).toHaveBeenCalledOnce();expect(win.location.assign).toHaveBeenCalledWith('/auth/login');
});
