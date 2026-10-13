import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('@supabase/ssr',()=>({createServerClient:(_url:unknown,_key:unknown,options:{cookies:{setAll:(rows:unknown[])=>void}})=>({auth:{getClaims:async()=>{options.cookies.setAll([{name:'session',value:'refreshed',options:{httpOnly:true}}]);return {data:null};}}})}));
import {updateSession} from '@/lib/middleware';
it('lets only read handlers own JSON auth while preserving refreshed cookies and all other redirects',async()=>{
 const read=await updateSession(new NextRequest('https://local/api/read/unread'));
 expect(read.headers.get('Location')).toBeNull();expect(read.cookies.get('session')?.value).toBe('refreshed');
 const other=await updateSession(new NextRequest('https://local/api/other'));
 expect(other.headers.get('Location')).toContain('/auth/login');expect(other.cookies.get('session')?.value).toBe('refreshed');
 const view=await updateSession(new NextRequest('https://local/bids?review=pending'));
 expect(view.headers.get('Location')).toContain('next=%2Fbids%3Freview%3Dpending');
});
