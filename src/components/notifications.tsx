"use client";
import { useEffect, useMemo, useState, useTransition } from "react";
import { formatInTimeZone } from "date-fns-tz";
import Link from "next/link";
import { Bell, BellRing, CheckCheck, Send, Pause, Play, X } from "lucide-react";
import { toast } from "sonner";
import type { WorkspaceData } from "@/lib/data";
import type { Row } from "@/lib/database.types";
import { getInboxNotifications, getClientMessages, markInboxNotificationAction, saveClientMessageAction, setClientMessageStatusAction, savePushSubscriptionAction, deletePushSubscriptionAction } from "@/app/(workspace)/actions";
import { PageHeading } from "./common";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { BID_TIMEZONE } from "@/lib/domain";
type InboxRow = Row<"inbox_notifications">;
type MessageRow = Row<"client_messages">;
function decodeKey(value: string) {
  const padded = value + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}
export function Notifications({ data, initialInbox, initialMessages }: { data: WorkspaceData; initialInbox: InboxRow[]; initialMessages: MessageRow[] }) {
  const manager = data.profile.role !== "bidder";
  const [inbox, setInbox] = useState(initialInbox);
  const [messages, setMessages] = useState(initialMessages);
  const [busy, start] = useTransition();
  const [workspace, setWorkspace] = useState(data.workspaces[0]?.id ?? "");
  const [audience, setAudience] = useState("all");
  const [kind, setKind] = useState("once");
  const [editingMessage, setEditingMessage] = useState<MessageRow | null>(null);
  const [messageView, setMessageView] = useState("all");
  const [highlightedNotification, setHighlightedNotification] = useState("");
  const [pane, setPane] = useState(data.profile.role === "admin" ? "inbox" : "messages");
  const unread = inbox.filter((row) => !row.read_at).length;
  const bidders = useMemo(() => data.bidders.filter((row) => !row.archived && (data.profile.role === "admin" || row.workspace_id === workspace)), [data.bidders, data.profile.role, workspace]);
  async function refreshInbox() {
    const result = await getInboxNotifications();
    if (result.error) toast.error(result.error); else setInbox(result.data ?? []);
  }
  useEffect(() => {
    if (data.profile.role === "client") return;
    const timer = window.setInterval(() => { void refreshInbox(); }, 30000);
    return () => window.clearInterval(timer);
  }, [data.profile.role]);
  useEffect(() => {
    const notification = new URLSearchParams(window.location.search).get("notification");
    if (!notification) return;
    window.requestAnimationFrame(() => {
      setHighlightedNotification(notification);
      document.getElementById(`notification-${notification}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);
  async function enablePush() {
    try {
    const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!publicKey || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) { toast.error("Browser push is unavailable. Your in-app inbox remains active."); return; }
    if (Notification.permission === "denied") { toast.error("Notifications are blocked in this browser. Allow them in browser settings to enable push."); return; }
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") { toast.message("Push disabled; messages will remain in your inbox."); return; }
    await navigator.serviceWorker.register("/push-worker.js");
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(publicKey) });
    const json = subscription.toJSON();
    if (!json.endpoint) { toast.error("This browser did not provide a push endpoint."); return; }
    const result = await savePushSubscriptionAction({ endpoint: json.endpoint, keys: json.keys });
    if (result.error) toast.error(result.error); else toast.success("Browser notifications enabled on this device");
    } catch {
      toast.error("Could not enable browser notifications. Retry or check browser settings; your inbox remains active.");
    }
  }
  async function disablePush() {
    if (!("serviceWorker" in navigator)) { toast.message("This browser does not have a push subscription to remove."); return; }
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    const result = await deletePushSubscriptionAction(subscription.endpoint);
    if (result.error) toast.error(result.error); else { await subscription.unsubscribe(); toast.success("Browser notifications disabled"); }
  }
  return <>
    <PageHeading eyebrow="STAY IN THE LOOP" title={manager ? "Notifications" : "Your inbox"} description={manager ? "Send updates to bidders now or on a Central Time schedule." : `${unread} unread messages. Your inbox stays available even when browser push is off.`}>
      {data.profile.role !== "client" && <Button variant="outline" onClick={refreshInbox}><BellRing size={15}/> Refresh inbox</Button>}
    </PageHeading>
    {data.profile.role === "admin" && <div className="mb-5 flex gap-1 border-b"><Button variant={pane === "inbox" ? "secondary" : "ghost"} onClick={() => setPane("inbox")}>Inbox{unread > 0 ? ` (${unread})` : ""}</Button><Button variant={pane === "messages" ? "secondary" : "ghost"} onClick={() => setPane("messages")}>Messages</Button></div>}
    {data.profile.role !== "client" && <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4"><div className="flex w-full min-w-0 items-start gap-3 sm:w-auto sm:flex-1 sm:items-center"><Bell size={18} className="shrink-0"/><p className="flex-1 text-sm">Browser notifications are optional and work per device. On iPhone or iPad, add Bidder Check to your Home Screen first.</p></div><Button variant="outline" onClick={enablePush}>Enable on this device</Button><Button variant="ghost" onClick={disablePush}>Disable</Button></div>}
    {manager && (data.profile.role !== "admin" || pane === "messages") && <form key={editingMessage?.id ?? "new"} action={(form) => start(async () => { const result=await saveClientMessageAction(form); if(result.error) toast.error(result.error); else { toast.success(form.get("send_now")==="on"?"Message published to inboxes":"Message saved"); setEditingMessage(null); const refreshed=await getClientMessages(); if(!refreshed.error)setMessages(refreshed.data??[]); } })} className="panel mb-7 grid gap-4 p-5 md:grid-cols-2">
      {editingMessage && <input type="hidden" name="id" value={editingMessage.id}/>}
      {data.profile.role === "admin" && <label className="space-y-1 text-xs">Workspace<select className="native-select" name="workspace_id" required value={workspace} onChange={(e)=>setWorkspace(e.target.value)}>{data.workspaces.map((w)=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
      <label className="space-y-1 text-xs">Recipients<select className="native-select" name="recipient_mode" value={audience} onChange={(e)=>setAudience(e.target.value)}><option value="all">All active bidders in workspace</option><option value="selected">Selected bidders</option></select></label>
      {audience === "selected" && <div className="max-h-32 space-y-1 overflow-auto rounded-md border p-2 md:col-span-2">{bidders.map((b)=><label key={b.user_id} className="flex items-center gap-2 text-xs"><input type="checkbox" name="recipient_ids" value={b.user_id} defaultChecked={editingMessage?.recipient_ids.includes(b.user_id)}/>{data.profiles.find(p=>p.id===b.user_id)?.display_name ?? "Bidder"}</label>)}</div>}
      <label className="space-y-1 text-xs">Title<Input name="title" maxLength={120} required placeholder="A quick update" defaultValue={editingMessage?.title}/></label>
      <label className="space-y-1 text-xs">Delivery<select className="native-select" name="schedule_kind" value={kind} onChange={(e)=>setKind(e.target.value)}><option value="once">One time</option><option value="daily">Daily</option><option value="weekly">Selected weekdays</option></select></label>
      {kind === "once" ? <label className="space-y-1 text-xs">Send at (Central Time)<Input type="datetime-local" name="scheduled_local" required defaultValue={editingMessage?.scheduled_at?formatInTimeZone(editingMessage.scheduled_at,BID_TIMEZONE,"yyyy-MM-dd'T'HH:mm"):undefined}/></label> : <><label className="space-y-1 text-xs">Central time<Input type="time" name="local_time" required defaultValue={editingMessage?.local_time?.slice(0,5)??"09:00"}/></label>{kind === "weekly" && <div className="flex flex-wrap gap-3 text-xs">{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d,i)=><label key={d} className="flex gap-1"><input type="checkbox" name="weekdays" value={i} defaultChecked={editingMessage?.weekdays.includes(String(i))}/>{d}</label>)}</div>}</>}
      <label className="space-y-1 text-xs md:col-span-2">Message<Textarea name="body" maxLength={4000} required rows={4} placeholder="Write a plain-text message for your bidders." defaultValue={editingMessage?.body}/></label>
      <div className="flex flex-wrap gap-2 md:col-span-2"><Button type="submit" name="send_now" value="on" disabled={busy||kind!=="once"} title={kind!=="once"?"Choose One time to send immediately":"Send immediately"}><Send size={14}/> Send now</Button><Button type="submit" name="save_draft" value="on" variant="outline" disabled={busy}>Save draft</Button>{editingMessage&&<Button type="button" variant="ghost" onClick={()=>setEditingMessage(null)}>Stop editing</Button>}<p className="self-center text-xs text-muted-foreground">All schedule times use America/Chicago. Drafts are not delivered.</p></div>
    </form>}
    {manager && (data.profile.role !== "admin" || pane === "messages") ? <><div className="mb-3 flex flex-wrap gap-1">{["all","draft","scheduled","active","paused","completed"].map(view=><Button key={view} size="sm" variant={messageView===view?"secondary":"ghost"} onClick={()=>setMessageView(view)} className="capitalize">{view}</Button>)}</div><div className="space-y-3">{messages.filter(m=>messageView==="all"||m.status===messageView).length===0 && <div className="panel p-8 text-center text-sm text-muted-foreground">No messages in this view.</div>}{messages.filter(m=>messageView==="all"||m.status===messageView).map(m=><article key={m.id} className="panel flex flex-wrap items-start gap-4 p-4"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{m.title}</h2><span className="rounded-full bg-muted px-2 py-1 text-[10px] capitalize">{m.status}</span><span className="text-xs text-muted-foreground">{m.schedule_kind}</span></div><p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{m.body}</p>{m.next_at&&<p className="mt-2 text-xs">Next delivery: {new Date(m.next_at).toLocaleString("en-US",{timeZone:"America/Chicago",timeZoneName:"short"})}</p>}</div>{["scheduled","active","paused","draft"].includes(m.status)&&<div className="flex gap-1">{m.status==="active"?<Button variant="outline" size="sm" onClick={()=>start(async()=>{const r=await setClientMessageStatusAction(m.id,"paused");if(r.error)toast.error(r.error);else{const x=await getClientMessages();if(!x.error)setMessages(x.data??[])}})}><Pause size={13}/> Pause</Button>:m.status==="paused"||m.status==="draft"?<Button variant="outline" size="sm" onClick={()=>start(async()=>{const r=await setClientMessageStatusAction(m.id,"active");if(r.error)toast.error(r.error);else{const x=await getClientMessages();if(!x.error)setMessages(x.data??[])}})}><Play size={13}/>{m.status==="draft"?"Publish":"Resume"}</Button>:null}<Button variant="outline" size="sm" onClick={()=>{setEditingMessage(m);setWorkspace(m.workspace_id);setAudience(m.recipient_mode);setKind(m.schedule_kind);window.scrollTo({top:0,behavior:"smooth"});}}>Edit</Button><Button variant="ghost" size="sm" onClick={()=>start(async()=>{const r=await setClientMessageStatusAction(m.id,"cancelled");if(r.error)toast.error(r.error);else{const x=await getClientMessages();if(!x.error)setMessages(x.data??[])}})}><X size={13}/> Cancel</Button></div>}</article>)}</div></> : data.profile.role !== "client" ? <div className="space-y-3">{inbox.length===0&&<div className="panel p-10 text-center"><Bell className="mx-auto mb-3 text-muted-foreground"/><p className="font-medium">All caught up</p><p className="mt-1 text-sm text-muted-foreground">{data.profile.role === "admin" ? "New client approval requests will appear here." : "Messages from your client will appear here."}</p></div>}{inbox.map((row)=>{ const client = row.client_id ? data.profiles.find(p => p.id === row.client_id) : undefined; const href = row.client_id ? `/users?tab=${client?.archived ? "archived" : client?.approval_status === "approved" ? "active" : "pending"}&highlight=${row.client_id}` : row.href; return <article id={`notification-${row.id}`} tabIndex={-1} key={row.id} className={`panel flex gap-3 p-4 outline-none transition-colors ${row.read_at?"opacity-75":"border-primary/30"} ${highlightedNotification===row.id?"ring-2 ring-primary":""}`}><div className="mt-1 size-2 shrink-0 rounded-full bg-primary"/><div className="min-w-0 flex-1"><h2 className="font-semibold">{row.title}</h2><p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{row.body}</p>{row.kind === "client_signup" && <p className="mt-2 text-xs text-muted-foreground">Current status: {client ? `${client.approval_status}${client.archived ? " · archived" : ""}` : "Account unavailable"}</p>}<time className="mt-3 block text-xs text-muted-foreground">{new Date(row.created_at).toLocaleString("en-US",{timeZone:"America/Chicago",timeZoneName:"short"})}</time></div>{href && <Link className="self-center text-sm font-medium text-primary underline-offset-4 hover:underline" href={href}>Review client</Link>}<Button variant="ghost" size="sm" disabled={!!row.resolved_at} onClick={()=>start(async()=>{const result=await markInboxNotificationAction(row.id,!row.read_at);if(result.error)toast.error(result.error);else setInbox(current=>current.map(n=>n.id===row.id?{...n,read_at:row.read_at?null:new Date().toISOString()}:n))})}><CheckCheck size={14}/>{row.read_at?"Mark unread":"Mark read"}</Button></article>;})}</div> : <div className="panel p-8 text-center text-sm text-muted-foreground">Notifications are not available for this account.</div>}
  </>;
}
