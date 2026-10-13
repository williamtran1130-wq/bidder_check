"use client";
import { useEffect, useMemo, useState, useTransition } from "react";
import { formatInTimeZone } from "date-fns-tz";
import Link from "next/link";
import { Bell, CheckCheck, Pause, Play, X } from "lucide-react";
import { toast } from "sonner";
import type { WorkspaceData } from "@/lib/data";
import type {
  InboxNotification,
  NotificationMessage,
  NotificationPage,
  NotificationPreview,
  NotificationResult,
  NotificationSchedule,
  NotificationCursor,
} from "@/lib/notification-types";
import {
  markNotificationRead,
  saveNotificationMessage,
  setNotificationStatus,
  previewNotificationSchedule,
  saveNotificationDevice,
  deleteNotificationDevice,
} from "@/app/(workspace)/notification-actions";
import {
  getNotificationPage,
  getNotificationById,
  getNotificationUnreadCount,
  getNotificationDeviceEnabled,
} from "@/lib/read-client";
import {
  useNotificationResource,
  useNotificationScope,
} from "@/lib/use-notifications";
import { notificationScope } from "@/lib/notification-scope";
import { refreshNotificationScope } from "@/lib/notification-store";
import { PageHeading } from "./common";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
const dateLabel = (value: string) =>
  new Date(value).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
const scope = (data: WorkspaceData) =>
  notificationScope(data.profile, data.workspaces);
function ErrorState({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div
      role="status"
      className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"
    >
      <span>{error}</span>
      <Button variant="outline" size="sm" onClick={retry}>
        Retry
      </Button>
    </div>
  );
}
function PushSettings() {
  const [state, setState] = useState<
    "checking" | "enabled" | "disabled" | "blocked" | "unavailable"
  >("checking");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    async function check() {
      if (
        !("serviceWorker" in navigator) ||
        !("Notification" in window) ||
        !("PushManager" in window)
      ) {
        if (alive) setState("unavailable");
        return;
      }
      if (Notification.permission === "denied") {
        if (alive) setState("blocked");
        return;
      }
      try {
        const registration = await navigator.serviceWorker.getRegistration?.();
        const subscription = await registration?.pushManager.getSubscription();
        const result = subscription
          ? await getNotificationDeviceEnabled(subscription.endpoint)
          : { data: false };
        if (alive)
          setState(
            result.error ? "unavailable" : result.data ? "enabled" : "disabled",
          );
      } catch {
        if (alive) setState("disabled");
      }
    }
    void check();
    return () => {
      alive = false;
    };
  }, []);
  async function enable() {
    setBusy(true);
    try {
      const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (
        !publicKey ||
        !("serviceWorker" in navigator) ||
        !("PushManager" in window) ||
        !("Notification" in window)
      ) {
        setState("unavailable");
        toast.error(
          "Browser push is unavailable. Your in-app inbox remains active.",
        );
        return;
      }
      if (Notification.permission === "denied") {
        setState("blocked");
        toast.error(
          "Notifications are blocked in this browser. Allow them in browser settings to enable push.",
        );
        return;
      }
      const permission =
        Notification.permission === "granted"
          ? "granted"
          : await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "disabled");
        toast.message("Push disabled; messages remain in your inbox.");
        return;
      }
      await navigator.serviceWorker.register("/push-worker.js");
      const registration = await navigator.serviceWorker.ready;
      const padded = publicKey + "=".repeat((4 - (publicKey.length % 4)) % 4);
      const applicationServerKey = Uint8Array.from(
        atob(padded.replace(/-/g, "+").replace(/_/g, "/")),
        (c) => c.charCodeAt(0),
      );
      const subscription =
        (await registration.pushManager.getSubscription?.()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        }));
      const json = subscription.toJSON();
      if (!json.endpoint) throw new Error("Missing endpoint");
      const result = await saveNotificationDevice({
        endpoint: json.endpoint,
        keys: json.keys,
      });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setState("enabled");
      toast.success("Browser notifications enabled on this device");
    } catch {
      toast.error(
        "Could not enable browser notifications. Retry or check browser settings; your inbox remains active.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function disable() {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        const result = await deleteNotificationDevice(subscription.endpoint);
        if (result.error) {
          toast.error(result.error);
          return;
        }
        await subscription.unsubscribe();
      }
      setState("disabled");
      toast.success("Browser notifications disabled");
    } catch {
      toast.error("Could not disable browser notifications. Please retry.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mb-6 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-xl border bg-card p-4 sm:flex sm:flex-wrap sm:items-center">
      <Bell size={18} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 text-sm sm:basis-48">
        <p>
          Browser notifications:{" "}
          {state === "checking"
            ? "checking this device"
            : state === "enabled"
              ? "enabled on this device"
              : state === "blocked"
                ? "blocked by browser permission"
                : state === "unavailable"
                  ? "unavailable on this device"
                  : "off on this device"}
          .
        </p>
        <p className="text-xs text-muted-foreground">
          Your in-app inbox stays active. On iPhone or iPad, add Bidder Check to
          your Home Screen first.
        </p>
      </div>
      <div className="col-span-2 flex flex-wrap gap-2 sm:contents">
        <Button
          variant="outline"
          disabled={busy || state === "enabled"}
          onClick={enable}
        >
          Enable on this device
        </Button>
        <Button
          variant="ghost"
          disabled={busy || state !== "enabled"}
          onClick={disable}
        >
          Disable
        </Button>
      </div>
    </div>
  );
}
function Composer({
  data,
  editing,
  stop,
  onSaved,
}: {
  data: WorkspaceData;
  editing: NotificationMessage | null;
  stop: () => void;
  onSaved: () => void;
}) {
  const [workspace, setWorkspace] = useState(
    editing?.workspace_id ?? data.workspaces[0]?.id ?? "",
  );
  const [audience, setAudience] = useState<"all" | "selected">(
    editing?.recipient_mode === "selected" ? "selected" : "all",
  );
  const [selected, setSelected] = useState(editing?.recipient_ids ?? []);
  const [title, setTitle] = useState(editing?.title ?? "");
  const [body, setBody] = useState(editing?.body ?? "");
  const [kind, setKind] = useState<NotificationSchedule["kind"]>(
    editing
      ? editing.send_on_publish
        ? "now"
        : (editing.schedule_kind as NotificationSchedule["kind"])
      : "now",
  );
  const [local, setLocal] = useState(
    editing?.scheduled_at
      ? formatInTimeZone(
          editing.scheduled_at,
          "America/Chicago",
          "yyyy-MM-dd'T'HH:mm",
        )
      : "",
  );
  const [time, setTime] = useState(editing?.local_time?.slice(0, 5) ?? "09:00");
  const [days, setDays] = useState((editing?.weekdays ?? []).map(Number));
  const [preview, setPreview] = useState<
    NotificationResult<NotificationPreview>
  >({});
  const [busy, start] = useTransition();
  const bidders = useMemo(
    () =>
      data.bidders.filter(
        (b) =>
          b.workspace_id === workspace &&
          !b.archived &&
          data.profiles.some((p) => p.id === b.user_id && !p.archived),
      ),
    [data.bidders, data.profiles, workspace],
  );
  const validSelected = selected.filter((id) =>
    bidders.some((b) => b.user_id === id),
  );
  const schedule = useMemo<NotificationSchedule>(
    () =>
      kind === "now"
        ? { kind }
        : kind === "once"
          ? { kind, scheduled_local: local }
          : kind === "daily"
            ? { kind, local_time: time }
            : { kind, local_time: time, weekdays: days },
    [kind, local, time, days],
  );
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void previewNotificationSchedule(schedule)
        .then((result) => {
          if (alive) setPreview(result);
        })
        .catch(() => {
          if (alive)
            setPreview({
              error:
                "Delivery preview is unavailable. Retry by checking the time.",
            });
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [schedule]);
  return (
    <form
      className="panel mb-7 space-y-5 p-5"
      action={(form) =>
        start(async () => {
          try {
            const result = await saveNotificationMessage({
              id: editing?.id,
              workspace_id: workspace,
              title,
              body,
              recipient_mode: audience,
              recipient_ids: audience === "selected" ? validSelected : [],
              schedule,
              draft: form.get("intent") === "draft",
            });
            if (result.error) {
              toast.error(result.error);
              return;
            }
            toast.success(
              result.data?.status === "paused"
                ? "Changes saved. Message remains paused."
                : form.get("intent") === "draft"
                  ? "Draft saved"
                  : kind === "now"
                    ? "Message queued for inbox publication"
                    : "Schedule saved",
            );
            onSaved();
          } catch {
            toast.error(
              "Could not confirm save. Check schedules before retrying.",
            );
          }
        })
      }
    >
      <section className="space-y-3">
        <h2 className="font-semibold">Recipients</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {data.profile.role === "admin" && (
            <label className="space-y-1 text-xs">
              Workspace
              <select
                aria-label="Workspace"
                className="native-select"
                value={workspace}
                disabled={!!editing}
                onChange={(e) => {
                  setWorkspace(e.target.value);
                  setSelected([]);
                }}
              >
                {data.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="space-y-1 text-xs">
            Recipients
            <select
              aria-label="Recipients"
              className="native-select"
              value={audience}
              onChange={(e) =>
                setAudience(e.target.value as "all" | "selected")
              }
            >
              <option value="all">All active bidders in workspace</option>
              <option value="selected">Selected bidders</option>
            </select>
          </label>
        </div>
        {audience === "selected" && (
          <div className="max-h-40 space-y-2 overflow-auto rounded-lg border p-3">
            {bidders.map((b) => (
              <label key={b.user_id} className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={validSelected.includes(b.user_id)}
                  onChange={(e) =>
                    setSelected((current) =>
                      e.target.checked
                        ? [...current, b.user_id]
                        : current.filter((id) => id !== b.user_id),
                    )
                  }
                />
                {data.profiles.find((p) => p.id === b.user_id)?.display_name ??
                  "Bidder"}
              </label>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {audience === "all" ? bidders.length : validSelected.length} eligible
          recipients in this workspace
        </p>
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Message</h2>
        <label className="block space-y-1 text-xs">
          Title
          <Input
            aria-label="Title"
            name="title"
            maxLength={120}
            required
            placeholder="A quick update"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="block space-y-1 text-xs">
          Message
          <Textarea
            aria-label="Message"
            name="body"
            maxLength={4000}
            required
            rows={4}
            placeholder="Write a plain-text message for your bidders."
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Delivery</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-xs">
            Delivery
            <select
              aria-label="Delivery"
              className="native-select"
              value={kind}
              onChange={(e) =>
                setKind(e.target.value as NotificationSchedule["kind"])
              }
            >
              <option value="now">Now</option>
              <option value="once">Once later</option>
              <option value="daily">Daily</option>
              <option value="weekly">Selected weekdays</option>
            </select>
          </label>
          {kind === "once" && (
            <label className="space-y-1 text-xs">
              Send at (Central Time)
              <Input
                aria-label="Send at (Central Time)"
                type="datetime-local"
                required
                value={local}
                onChange={(e) => setLocal(e.target.value)}
              />
            </label>
          )}
          {(kind === "daily" || kind === "weekly") && (
            <label className="space-y-1 text-xs">
              Central time
              <Input
                aria-label="Central time"
                type="time"
                required
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
          )}
        </div>
        {kind === "weekly" && (
          <div className="flex flex-wrap gap-3 text-xs">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, i) => (
              <label key={day} className="flex gap-1">
                <input
                  type="checkbox"
                  checked={days.includes(i)}
                  onChange={(e) =>
                    setDays((current) =>
                      e.target.checked
                        ? [...current, i]
                        : current.filter((d) => d !== i),
                    )
                  }
                />
                {day}
              </label>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {preview.error
            ? preview.error
            : kind === "now"
              ? "Queued for inbox publication after you send."
              : preview.data
                ? `Next delivery: ${dateLabel(preview.data.next_at)}`
                : "Checking next delivery…"}
        </p>
        {editing?.status === "paused" && (
          <p className="text-xs">
            This message stays paused after saving. Resume it when ready.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Schedules repeat your authored message in America/Chicago. Drafts are
          not delivered.
        </p>
      </section>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="intent" value="publish" disabled={busy}>
          {editing && editing.status !== "draft"
            ? "Save changes"
            : kind === "now"
              ? "Send now"
              : "Schedule"}
        </Button>
        {(!editing || editing.status === "draft") && (
          <Button
            type="submit"
            name="intent"
            value="draft"
            variant="outline"
            disabled={busy}
          >
            Save draft
          </Button>
        )}
        {editing && (
          <Button type="button" variant="ghost" onClick={stop}>
            Stop editing
          </Button>
        )}
      </div>
    </form>
  );
}
function List({
  data,
  kind,
  workspace,
  status,
  initial,
  onEdit,
}: {
  data: WorkspaceData;
  kind: "inbox" | "messages";
  workspace: string;
  status: string;
  initial?: NotificationResult<
    NotificationPage<InboxNotification | NotificationMessage>
  >;
  onEdit: (message: NotificationMessage) => void;
}) {
  const [cursors, setCursors] = useState<Array<NotificationCursor | null>>([
    null,
  ]);
  const cursor = cursors.at(-1) ?? null;
  const query = {
    kind,
    workspace_id: kind === "messages" ? workspace : undefined,
    status: kind === "messages" ? status : undefined,
    cursor,
  };
  const resource = useNotificationResource(
    `${scope(data)}page:${JSON.stringify(query)}`,
    () => getNotificationPage(query),
    cursor ? {} : initial,
  );
  const [highlight, setHighlight] = useState("");
  const deep = useNotificationResource<InboxNotification>(
    `${scope(data)}by-id:${highlight}`,
    async () => (highlight ? getNotificationById(highlight) : {}),
  );
  const [busy, start] = useTransition();
  useEffect(() => {
    if (kind !== "inbox") return;
    const id = new URLSearchParams(window.location.search).get("notification");
    const frame = window.requestAnimationFrame(() => setHighlight(id ?? ""));
    return () => window.cancelAnimationFrame(frame);
  }, [kind]);
  useEffect(() => {
    if (highlight && deep.data)
      document
        .getElementById(`notification-${highlight}`)
        ?.scrollIntoView({ block: "center" });
  }, [highlight, deep.data]);
  const rows = resource.data?.rows ?? [];
  const inbox = rows as InboxNotification[];
  const shown =
    deep.data && !inbox.some((row) => row.id === deep.data?.id)
      ? [deep.data, ...inbox]
      : inbox;
  const refresh = () => refreshNotificationScope(scope(data));
  async function change(
    message: NotificationMessage,
    value: "active" | "paused" | "cancelled",
  ) {
    const result = await setNotificationStatus(message.id, value);
    if (result.error) toast.error(result.error);
    else await refresh();
  }
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="outline" onClick={() => void refresh()}>
          Refresh {kind === "inbox" ? "inbox" : "messages"}
        </Button>
      </div>
      {resource.error && (
        <ErrorState
          error={resource.error}
          retry={() => void resource.retry()}
        />
      )}{" "}
      {deep.error && (
        <ErrorState error={deep.error} retry={() => void deep.retry()} />
      )}
      {!resource.data && !resource.error && (
        <p role="status">Loading notifications…</p>
      )}
      <div className="space-y-3">
        {resource.data &&
          !resource.error &&
          rows.length === 0 &&
          !deep.data && (
            <div className="panel p-8 text-center">
              <p className="font-medium">
                {kind === "messages"
                  ? "No messages in this view."
                  : "All caught up"}
              </p>
              {kind === "inbox" && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {data.profile.role === "admin"
                    ? "New client approval requests will appear here."
                    : "Messages from your client will appear here."}
                </p>
              )}
            </div>
          )}
        {kind === "messages"
          ? (rows as NotificationMessage[]).map((m) => (
              <article
                key={m.id}
                className="panel flex flex-wrap items-start gap-4 p-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-semibold">{m.title}</h2>
                    <span className="rounded-full bg-muted px-2 py-1 text-xs">
                      {m.status === "paused"
                        ? "Paused"
                        : m.status === "draft"
                          ? "Draft"
                          : m.status === "cancelled"
                            ? "Cancelled"
                            : m.next_at
                              ? new Date(m.next_at) <= new Date()
                                ? "Queued"
                                : "Scheduled"
                              : m.latest_publication
                                ? `Published to ${m.latest_publication.recipient_count} inboxes`
                                : "Publication pending"}
                    </span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                    {m.body}
                  </p>
                  {m.next_at && (
                    <p className="mt-2 text-xs">
                      Next delivery: {dateLabel(m.next_at)}
                    </p>
                  )}
                  {m.latest_publication && (
                    <p className="mt-2 text-xs">
                      Published to {m.latest_publication.recipient_count}{" "}
                      inboxes · {dateLabel(m.latest_publication.published_at)}
                    </p>
                  )}
                </div>
                {["active", "scheduled", "paused", "draft"].includes(
                  m.status,
                ) && (
                  <div className="flex flex-wrap gap-1">
                    {["active", "scheduled"].includes(m.status) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => start(() => change(m, "paused"))}
                      >
                        <Pause size={13} /> Pause
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => start(() => change(m, "active"))}
                      >
                        <Play size={13} />
                        {m.status === "draft" ? "Publish" : "Resume"}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onEdit(m)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => start(() => change(m, "cancelled"))}
                    >
                      <X size={13} /> Cancel
                    </Button>
                  </div>
                )}
              </article>
            ))
          : shown.map((row) => {
              const client = row.client_id
                ? data.profiles.find((p) => p.id === row.client_id)
                : undefined;
              const href = row.client_id
                ? `/users?tab=${client?.archived ? "archived" : client?.approval_status === "approved" ? "active" : "pending"}&highlight=${row.client_id}`
                : row.href;
              return (
                <article
                  key={row.id}
                  id={`notification-${row.id}`}
                  tabIndex={-1}
                  className={`panel flex gap-3 p-4 ${highlight === row.id ? "ring-2 ring-primary" : ""} ${row.read_at ? "opacity-75" : "border-primary/30"}`}
                >
                  <div className="min-w-0 flex-1">
                    <h2 className="font-semibold">{row.title}</h2>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                      {row.body}
                    </p>
                    {row.kind === "client_signup" && (
                      <p className="mt-2 text-xs">
                        Current status:{" "}
                        {client
                          ? `${client.approval_status}${client.archived ? " · archived" : ""}`
                          : "Account unavailable"}
                      </p>
                    )}
                    <time className="mt-3 block text-xs text-muted-foreground">
                      {dateLabel(row.created_at)}
                    </time>
                  </div>
                  {href && (
                    <Link
                      className="self-center text-sm text-primary"
                      href={href}
                    >
                      Review client
                    </Link>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || !!row.resolved_at}
                    onClick={() =>
                      start(async () => {
                        const result = await markNotificationRead(
                          row.id,
                          !row.read_at,
                        );
                        if (result.error) toast.error(result.error);
                        else {
                          await refresh();
                        }
                      })
                    }
                  >
                    <CheckCheck size={14} />
                    {row.read_at ? "Mark unread" : "Mark read"}
                  </Button>
                </article>
              );
            })}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button
          variant="outline"
          disabled={cursors.length === 1}
          onClick={() => setCursors((current) => current.slice(0, -1))}
        >
          Previous
        </Button>
        <span className="text-xs">Page {cursors.length}</span>
        <Button
          variant="outline"
          disabled={!resource.data?.next_cursor || !!resource.error}
          onClick={() =>
            setCursors((current) => [...current, resource.data!.next_cursor])
          }
        >
          Next
        </Button>
      </div>
    </>
  );
}
type NotificationsProps = {
  data: WorkspaceData;
  initialInbox?: InboxNotification[];
  initialMessages?: NotificationMessage[];
  initialInboxPage?: NotificationResult<
    NotificationPage<InboxNotification | NotificationMessage>
  >;
  initialMessagesPage?: NotificationResult<
    NotificationPage<InboxNotification | NotificationMessage>
  >;
};
export function Notifications(props: NotificationsProps) {
  const notificationKey = scope(props.data);
  const allowInitial = useNotificationScope(notificationKey);
  const scoped = allowInitial ? props : { data: props.data };
  return props.data.profile.role === "client" ? (
    <NotificationContent key={notificationKey} {...scoped} />
  ) : (
    <CountedNotificationContent key={notificationKey} {...scoped} />
  );
}
function CountedNotificationContent(props: NotificationsProps) {
  const { data, initialInbox = [], initialInboxPage } = props;
  const unread = useNotificationResource(
    `${scope(data)}unread`,
    getNotificationUnreadCount,
    initialInboxPage?.error
      ? { error: initialInboxPage.error }
      : {
          data:
            initialInboxPage?.data?.unread_count ??
            initialInbox.filter((row) => !row.read_at && !row.resolved_at)
              .length,
        },
  );
  return <NotificationContent {...props} unread={unread} />;
}
function NotificationContent({
  data,
  initialInbox = [],
  initialMessages = [],
  initialInboxPage,
  initialMessagesPage,
  unread = { data: 0 },
}: NotificationsProps & { unread?: NotificationResult<number> }) {
  const manager = data.profile.role !== "bidder";
  const [pane, setPane] = useState(
    data.profile.role === "client" ? "messages" : "inbox",
  );
  const [workspace, setWorkspace] = useState(data.workspaces[0]?.id ?? "");
  const [view, setView] = useState("all");
  const [editing, setEditing] = useState<NotificationMessage | null>(null);
  const [composerVersion, setComposerVersion] = useState(0);
  const stop = () => {
    setEditing(null);
    setComposerVersion((v) => v + 1);
  };
  return (
    <>
      <PageHeading
        eyebrow="STAY IN THE LOOP"
        title={manager ? "Notifications" : "Your inbox"}
        description={
          manager
            ? "Send updates to bidders now or on a Central Time schedule."
            : unread.error
              ? "Unread count unavailable. Your inbox remains available below."
              : `${unread.data ?? 0} unread messages. Your inbox stays available even when browser push is off.`
        }
      />
      {data.profile.role === "admin" && (
        <div className="mb-5 flex gap-1 border-b">
          <Button
            variant={pane === "inbox" ? "secondary" : "ghost"}
            onClick={() => setPane("inbox")}
          >
            Inbox{unread.data ? ` (${unread.data})` : ""}
          </Button>
          <Button
            variant={pane === "messages" ? "secondary" : "ghost"}
            onClick={() => setPane("messages")}
          >
            Messages
          </Button>
        </div>
      )}
      {data.profile.role !== "client" && <PushSettings />}
      {manager && pane === "messages" ? (
        <>
          <Composer
            key={editing?.id ?? `new-${composerVersion}`}
            data={data}
            editing={editing}
            stop={stop}
            onSaved={() => {
              stop();
              void refreshNotificationScope(scope(data));
            }}
          />
          <div className="mb-3 flex flex-wrap gap-1">
            {data.profile.role === "admin" && (
              <select
                aria-label="Message workspace"
                className="native-select max-w-64"
                value={workspace}
                onChange={(e) => setWorkspace(e.target.value)}
              >
                {data.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            )}
            {["all", "draft", "scheduled", "active", "paused", "completed"].map(
              (value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={view === value ? "secondary" : "ghost"}
                  onClick={() => setView(value)}
                  className="capitalize"
                >
                  {value}
                </Button>
              ),
            )}
          </div>
          <List
            key={`${workspace}:${view}`}
            data={data}
            kind="messages"
            workspace={workspace}
            status={view}
            initial={
              view === "all" && workspace === data.workspaces[0]?.id
                ? (initialMessagesPage ?? {
                    data: {
                      rows: initialMessages,
                      next_cursor: null,
                      unread_count: 0,
                    },
                  })
                : undefined
            }
            onEdit={(message) => {
              setEditing(message);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          />
        </>
      ) : (
        <List
          data={data}
          kind="inbox"
          workspace=""
          status="all"
          initial={
            initialInboxPage ?? {
              data: {
                rows: initialInbox,
                next_cursor: null,
                unread_count: unread.data ?? 0,
              },
            }
          }
          onEdit={() => {}}
        />
      )}
    </>
  );
}
