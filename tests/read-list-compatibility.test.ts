import { expect, it, vi, beforeEach } from 'vitest';
const h=vi.hoisted(()=>({role:'client',rpc:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('@/lib/auth',()=>({getContext:async()=>({profile:{role:h.role},supabase:{rpc:h.rpc}})}));
import {getBidRows} from '@/lib/read-services';
const query={search:'text',status:'all',arrangement:'all',resume:'all',bidder:'all',source:'all',job:'all',columnFilters:[{id:'company',value:['A','B']},{id:'screenshot_size_bytes',value:{min:0,max:4000}}],sorting:[{id:'screenshot_size_bytes',desc:false}],pageIndex:2,pageSize:25};
beforeEach(()=>{h.rpc.mockReset();h.role='client';});
it('retains exact count/source/status metadata, filters, sorting and manager active-row rate',async()=>{
 h.rpc.mockResolvedValueOnce({data:{rows:[{id:'row'}],total:44,sources:['LinkedIn'],statusCounts:{pending_review:3}},error:null}).mockResolvedValueOnce({data:{bidders:{},resumes:{},bids:{row:250}},error:null});
 const result=await getBidRows('all','','',false,undefined,query);
 expect(result.data).toMatchObject({rows:[{id:'row',rate_cents:250}],total:44,sources:['LinkedIn'],statusCounts:{pending_review:3}});
 expect(h.rpc.mock.calls[0][1].p_query).toMatchObject({columnFilters:{company:['A','B'],screenshot_size_bytes:{min:0,max:4000}},sorting:query.sorting,pageIndex:2,pageSize:25});
});
it('does not request bidder money and performs no fallback after a timeout',async()=>{
 h.role='bidder';h.rpc.mockResolvedValueOnce({data:{rows:[{id:'row'}],total:1,sources:[],statusCounts:{}},error:null});
 expect((await getBidRows('all','','',false,undefined,query)).data?.rows[0]).not.toHaveProperty('rate_cents');expect(h.rpc).toHaveBeenCalledTimes(1);
 h.rpc.mockReset().mockResolvedValue({error:{code:'57014'}});expect(await getBidRows('all','','',false,undefined,query)).toMatchObject({code:'statement_timeout'});expect(h.rpc).toHaveBeenCalledTimes(1);
});
