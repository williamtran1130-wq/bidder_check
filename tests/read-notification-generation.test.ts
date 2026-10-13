import { expect, it, vi } from 'vitest';
import { notificationResource, refreshNotificationScope, discardNotificationScope } from '@/lib/notification-store';
it('mutation invalidation bypasses stale in-flight notification reads while focus deduplicates', async () => {
 vi.stubGlobal('window', new EventTarget());
 vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
 const resolvers: ((v:{data:number})=>void)[] = [];
 const read = vi.fn(() => new Promise<{data:number}>(r=>resolvers.push(r)));
 const resource=notificationResource('task7:',read,{data:1});
 const unsubscribe=resource.subscribe(()=>{});
 const old=resource.refresh();
 const fresh=refreshNotificationScope('task7:');
 expect(read).toHaveBeenCalledTimes(2);
 resolvers[1]({data:3}); await fresh;
 resolvers[0]({data:2}); await old;
 expect(resource.snapshot().data).toBe(3);
 unsubscribe(); discardNotificationScope('task7:'); vi.unstubAllGlobals();
});
