import { expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
const h=vi.hoisted(()=>({destination:''}));
vi.mock('server-only',()=>({}));
vi.mock('@/lib/auth',()=>({getActor:async()=>{if(h.destination)throw Object.assign(new Error('Access changed'),{destination:h.destination})}}));
it('malformed payloads, unknown operations and denied requests are private JSON without redirects',async()=>{
 expect(existsSync('src/lib/read-handler.ts')).toBe(true);
 const {handleRead}=await import('@/lib/read-handler');
 for(const [operation,url,method,body,status] of [['unknown','https://local/api/read/unknown','GET',undefined,404],['bids','https://local/api/read/bids','POST','{',400],['bids','https://local/api/read/bids?q=null','GET',undefined,400]] as const){
 const res=await handleRead(new Request(url,{method,body}),operation);
 expect(res.status).toBe(status);expect(res.headers.get('Cache-Control')).toBe('private, no-store');expect(res.headers.get('Location')).toBeNull();
 }
 h.destination='/auth/inactive';const denied=await handleRead(new Request('https://local/api/read/purges'),'purges');
 expect(denied.status).toBe(403);expect(await denied.json()).toMatchObject({destination:'/auth/inactive'});expect(denied.headers.get('Cache-Control')).toBe('private, no-store');h.destination='';
});
