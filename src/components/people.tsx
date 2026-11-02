"use client";
import { refreshWorkspace } from "@/lib/report-cache";
import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Search, ArrowUpRight, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import type { WorkspaceData } from "@/lib/data";
import type { Row } from "@/lib/database.types";
import type { BidderRow } from "@/lib/workspace-types";
import { usd, initials } from "@/lib/domain";
import {
  reviewClient,
  getManagedAccountOperations,
  resumeManagedAccountOperation,
  abandonManagedAccountOperation,
  submitManagedAccountOperation,
  changeManagedBidderPassword,
} from "@/app/(workspace)/actions";
import {
  freezeAccountRequest,
  readAccountRequest,
  clearAccountRequest,
  type FrozenAccountRequest,
} from "@/lib/account-operation-client";
import type {
  AccountActionResult,
  AccountKind,
  AccountOperation,
} from "@/lib/account-operation-types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "./ui/dialog";
import {
  PageHeading,
  Field,
  SelectField,
  SaveButton,
  EmptyState,
} from "./common";

function useAccountRequest(open: boolean, scope: string) {
  const [actor, setActor] = useState<string | null>(null);
  const [saved, setSaved] = useState<FrozenAccountRequest | null>(null);
  const [message, setMessage] = useState("");
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    if (!open) return;
    let current = true;
    getManagedAccountOperations()
      .then((result) => {
        if (!current) return;
        if (!result.data) {
          setMessage(result.error ?? "Account recovery is unavailable.");
          return;
        }
        setActor(result.data.actorId);
        try {
          setSaved(
            readAccountRequest(localStorage, result.data.actorId, scope),
          );
        } catch {
          setMessage(
            "The saved request could not be read. Use Pending account changes to review it.",
          );
        }
      })
      .catch(() => {
        if (current)
          setMessage(
            "Account recovery is unavailable. Reopen this dialog to retry.",
          );
      });
    return () => {
      current = false;
    };
  }, [open, scope]);
  async function run(
    request: FrozenAccountRequest,
    credentials?: { password: string; confirmation: string },
  ): Promise<AccountActionResult> {
    if (inFlight.current) return { error: "This request is already running." };
    inFlight.current = true;
    setBusy(true);
    try {
      const result =
        request.kind === "set_bidder_password"
          ? credentials
            ? await changeManagedBidderPassword(
                request.requestId,
                request.fields.user_id,
                credentials.password,
                credentials.confirmation,
              )
            : await resumeManagedAccountOperation(request.requestId, true)
          : await submitManagedAccountOperation(
              request.requestId,
              request.kind,
              request.fields,
            );
      setRequiresPassword(result.requiresPassword === true);
      if (
        result.operation?.status === "completed" ||
        result.operation?.status === "abandoned" ||
        result.notStarted
      ) {
        clearAccountRequest(localStorage, actor!, scope);
        setSaved(null);
      }
      setMessage(result.error ?? "");
      window.dispatchEvent(new Event("managed-account-change"));
      return result;
    } catch {
      const error =
        "The response was lost. The saved request is unchanged. Check and resume it before making another change.";
      setMessage(error);
      window.dispatchEvent(new Event("managed-account-change"));
      return { error };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function submit(
    kind: AccountKind,
    form: FormData,
    credentials?: { password: string; confirmation: string },
  ): Promise<AccountActionResult> {
    if (!actor)
      return { error: "Account recovery is still loading. Please retry." };
    try {
      const request = freezeAccountRequest(localStorage, actor, scope, {
        kind,
        fields: Object.fromEntries(
          Array.from(form.entries()).map(([key, value]) => [
            key,
            String(value),
          ]),
        ),
      });
      setSaved(request);
      return run(request, credentials);
    } catch {
      const error =
        "The request could not be saved for recovery. Enable browser storage before continuing.";
      setMessage(error);
      return { error };
    }
  }
  return {
    ready: !!actor,
    busy,
    requiresPassword,
    saved,
    message,
    submit,
    retry: () =>
      saved
        ? run(saved)
        : Promise.resolve({ error: "No saved request" } as AccountActionResult),
  };
}
function AccountRequestNotice({
  request,
  pending,
  retry,
}: {
  request: ReturnType<typeof useAccountRequest>;
  pending: boolean;
  retry: () => void;
}) {
  if (!request.saved && !request.message) return null;
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm" role="status">
      <p>
        {request.message ||
          "This request has a saved recovery record. Its original values will be used when you resume."}
      </p>
      {request.saved && (
        <>
          <p className="break-all text-xs">
            Request: {request.saved.requestId}
          </p>
          <dl className="space-y-1">
            {Object.entries(request.saved.fields)
              .filter(([name]) =>
                ["display_name", "email", "rate", "archived"].includes(name),
              )
              .map(([name, value]) => (
                <div key={name} className="break-all">
                  <dt className="inline font-medium">
                    {
                      {
                        display_name: "Name",
                        email: "Email",
                        rate: "Rate (USD)",
                        archived: "Archived",
                      }[name]
                    }
                    :{" "}
                  </dt>
                  <dd className="inline">{value || "Not set"}</dd>
                </div>
              ))}
          </dl>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={retry}
          >
            Check and resume saved request
          </Button>
        </>
      )}
    </div>
  );
}
function AccountRecovery() {
  const [items, setItems] = useState<AccountOperation[]>([]);
  const [actor, setActor] = useState("");
  const [admin, setAdmin] = useState(false);
  const [pending, start] = useTransition();
  const [message, setMessage] = useState("");
  const [passwordRequest, setPasswordRequest] = useState<string | null>(null);
  const router = useRouter();
  async function load() {
    const result = await getManagedAccountOperations();
    if (result.data) {
      setItems(result.data.operations);
      setActor(result.data.actorId);
      setAdmin(result.data.admin);
    } else setMessage(result.error ?? "Account recovery is unavailable.");
  }
  useEffect(() => {
    let live = true;
    const refresh = () => {
      void getManagedAccountOperations()
        .then((result) => {
          if (!live) return;
          if (result.data) {
            setItems(result.data.operations);
            setActor(result.data.actorId);
            setAdmin(result.data.admin);
          } else setMessage(result.error ?? "Account recovery is unavailable.");
        })
        .catch(() => {
          if (live)
            setMessage(
              "Account recovery is unavailable. Refresh to check pending changes.",
            );
        });
    };
    refresh();
    window.addEventListener("managed-account-change", refresh);
    return () => {
      live = false;
      window.removeEventListener("managed-account-change", refresh);
    };
  }, []);
  if (!items.length && !message) return null;
  return (
    <section
      className="panel mb-6 space-y-3 p-4"
      aria-label="Pending account changes"
    >
      <h2 className="font-semibold">Pending account changes</h2>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {items.map((op) => (
        <div
          key={op.requestId}
          className="space-y-2 rounded border p-3 text-sm"
        >
          <p className="break-all">
            {op.payload.email || op.targetId}: {op.kind.replaceAll("_", " ")}
          </p>
          <p>
            {op.authStep === "accepted"
              ? "Sign-in change confirmed; account details or audit completion remain pending."
              : "Completion is unconfirmed. Check this saved request before making another change."}
          </p>
          <p className="break-all text-xs">Request: {op.requestId}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={pending || op.actorId !== actor}
              onClick={() =>
                start(async () => {
                  try {
                    const result = await resumeManagedAccountOperation(
                      op.requestId,
                    );
                    setMessage(result.error ?? "Account change completed.");
                    setPasswordRequest(
                      result.requiresPassword ? op.requestId : null,
                    );
                    await load();
                    refreshWorkspace(router);
                  } catch {
                    setMessage(
                      "The response was lost. Check this same request again.",
                    );
                  }
                })
              }
            >
              Check and resume
            </Button>
            {admin && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => {
                  if (
                    !window.confirm(
                      "Abandon the remaining work? Confirmed sign-in changes will remain. The administrator and original request will be recorded.",
                    )
                  )
                    return;
                  start(async () => {
                    try {
                      const result = await abandonManagedAccountOperation(
                        op.requestId,
                      );
                      setMessage(
                        result.error ??
                          result.operation?.disposition ??
                          "Remaining work abandoned.",
                      );
                      await load();
                      refreshWorkspace(router);
                    } catch {
                      setMessage(
                        "Disposition could not be confirmed. Check this request again.",
                      );
                    }
                  });
                }}
              >
                Abandon remaining work
              </Button>
            )}
          </div>
          {passwordRequest === op.requestId && op.actorId === actor && (
            <PasswordEntry
              disabled={pending}
              onSubmit={async (password, confirmation) => {
                try {
                  const result = await changeManagedBidderPassword(
                    op.requestId,
                    op.targetId,
                    password,
                    confirmation,
                  );
                  setMessage(
                    result.error ??
                      "Password changed. Bidder signed out on all devices.",
                  );
                  if (result.operation?.status === "completed")
                    setPasswordRequest(null);
                  await load();
                  window.dispatchEvent(new Event("managed-account-change"));
                } catch {
                  setMessage(
                    "The response was lost. Check this same request again.",
                  );
                }
              }}
            />
          )}
          {op.actorId !== actor && (
            <p>
              The original manager must resume this request. An administrator
              can review and abandon the remaining work.
            </p>
          )}
        </div>
      ))}
    </section>
  );
}
export function CreateBidderDialog({
  data,
  invitation,
  workspaceId,
}: {
  data: WorkspaceData;
  invitation?: Row<"invitations">;
  workspaceId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const request = useAccountRequest(
    open,
    `create-bidder:${invitation?.id ?? workspaceId ?? "new"}`,
  );
  function completed(result: AccountActionResult) {
    if (result.error) toast.error(result.error);
    else if (result.operation?.status === "completed") {
      toast.success("Bidder account created. Initial password: 123456");
      setOpen(false);
      refreshWorkspace(router);
    }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant={invitation ? "outline" : "default"}
          size={invitation ? "sm" : "default"}
        >
          {invitation ? <RotateCcw size={15} /> : <Plus size={16} />}{" "}
          {invitation ? "Retry creation" : "Add bidder"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a bidder account</DialogTitle>
          <DialogDescription>
            Their initial password is 123456. Share their sign-in details
            directly; they can change their password in Settings.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          action={(form) =>
            start(async () => {
              completed(await request.submit("create_bidder", form));
            })
          }
        >
          <fieldset
            disabled={pending || !!request.saved || !request.ready}
            className="space-y-4"
          >
            <SelectField
              label="Workspace"
              name="workspace_id"
              defaultValue={
                invitation?.workspace_id ??
                workspaceId ??
                data.workspaces[0]?.id
              }
              required
            >
              {data.workspaces
                .filter((w) => {
                  const owner = data.profiles.find((p) => p.id === w.owner_id);
                  return (
                    !owner?.archived && owner?.approval_status === "approved"
                  );
                })
                .map((w) => (
                  <option value={w.id} key={w.id}>
                    {w.name}
                  </option>
                ))}
            </SelectField>
            <Field
              label="Full name"
              name="display_name"
              required
              defaultValue={invitation?.display_name}
            />
            <Field
              label="Email address"
              name="email"
              type="email"
              required
              defaultValue={invitation?.email}
            />
            <Field
              label="Default rate per bid (USD)"
              name="rate"
              type="number"
              min="0"
              step="0.01"
              defaultValue={
                invitation?.default_rate_cents != null
                  ? invitation.default_rate_cents / 100
                  : ""
              }
              placeholder="Set later"
            />
            <div className="flex justify-end pt-2">
              <SaveButton pending={pending} label="Create bidder" />
            </div>
          </fieldset>
        </form>
        <AccountRequestNotice
          request={request}
          pending={pending}
          retry={() => start(async () => completed(await request.retry()))}
        />
      </DialogContent>
    </Dialog>
  );
}
export function EditPerson({
  person,
  bidder,
}: {
  person: Row<"profiles">;
  bidder?: BidderRow;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const request = useAccountRequest(open, `edit:${person.id}`);
  function completed(result: AccountActionResult) {
    if (result.error) toast.error(result.error);
    else if (result.operation?.status === "completed") {
      toast.success("Account updated");
      setOpen(false);
      refreshWorkspace(router);
    }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Manage
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Manage {person.display_name}</DialogTitle>
          <DialogDescription>
            Archived accounts lose access. Their history and earnings are
            preserved.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          action={(form) =>
            start(async () => {
              completed(
                await request.submit(
                  bidder ? "update_bidder" : "update_client",
                  form,
                ),
              );
            })
          }
        >
          <fieldset
            disabled={pending || !!request.saved || !request.ready}
            className="space-y-4"
          >
            <input type="hidden" name="user_id" value={person.id} />
            <Field
              label="Full name"
              name="display_name"
              defaultValue={person.display_name}
              required
            />
            <Field
              label="Email address"
              name="email"
              type="email"
              required
              defaultValue={person.email}
            />
            {bidder && (
              <Field
                label="Default rate per bid (USD)"
                name="rate"
                type="number"
                min="0"
                step="0.01"
                defaultValue={
                  bidder.default_rate_cents == null
                    ? ""
                    : bidder.default_rate_cents / 100
                }
              />
            )}
            <SelectField
              label="Account status"
              name="archived"
              defaultValue={String(person.archived)}
            >
              <option value="false">Active</option>
              <option value="true">Archived — remove access</option>
            </SelectField>
            <SaveButton pending={pending} />
          </fieldset>
        </form>
        <AccountRequestNotice
          request={request}
          pending={pending}
          retry={() => start(async () => completed(await request.retry()))}
        />
        {bidder ? (
          <BidderSecurity person={person} />
        ) : (
          <PasswordReset person={person} />
        )}
      </DialogContent>
    </Dialog>
  );
}
function PasswordEntry({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (password: string, confirmation: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, start] = useTransition();
  const errorId = useId();
  const mismatch = !!confirmation && password !== confirmation;
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          disabled ||
          pending ||
          mismatch ||
          password.length < 8 ||
          password.length > 128
        )
          return;
        start(async () => {
          try {
            await onSubmit(password, confirmation);
          } finally {
            setPassword("");
            setConfirmation("");
          }
        });
      }}
    >
      <fieldset disabled={disabled || pending} className="space-y-3">
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Field
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          aria-invalid={mismatch}
          aria-describedby={mismatch ? errorId : undefined}
        />
        {mismatch && (
          <p id={errorId} role="alert" className="text-sm text-destructive">
            Passwords must match.
          </p>
        )}
        <Button
          type="submit"
          variant="outline"
          disabled={
            disabled ||
            pending ||
            password.length < 8 ||
            password.length > 128 ||
            password !== confirmation
          }
        >
          {pending ? "Changing password…" : "Change password"}
        </Button>
      </fieldset>
    </form>
  );
}
function BidderSecurity({ person }: { person: Row<"profiles"> }) {
  const [confirmed, setConfirmed] = useState(false);
  const request = useAccountRequest(true, `security:${person.id}`);
  function completed(result: AccountActionResult) {
    if (result.error) toast.error(result.error);
    else if (result.operation?.status === "completed") {
      toast.success(
        result.operation.kind === "sign_out_bidder"
          ? "Bidder signed out on all devices"
          : "Password changed. Bidder signed out on all devices.",
      );
      setConfirmed(false);
    }
  }
  return (
    <section
      className="space-y-4 border-t pt-4"
      aria-label="Bidder password and access"
    >
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Sign out all devices</h3>
        <p className="text-sm text-muted-foreground">
          End all current sessions for {person.email}. They can sign in again
          with their current password.
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            aria-label="Confirm sign out on all devices"
            checked={confirmed}
            disabled={request.busy || !!request.saved || !request.ready}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          Confirm sign out on all devices
        </label>
        <Button
          variant="outline"
          disabled={
            !confirmed || request.busy || !!request.saved || !request.ready
          }
          onClick={async () => {
            const form = new FormData();
            form.set("user_id", person.id);
            completed(await request.submit("sign_out_bidder", form));
          }}
        >
          Sign out all devices
        </Button>
      </div>
      <div className="space-y-3 border-t pt-4">
        <h3 className="text-sm font-semibold">Change password</h3>
        <p className="text-sm text-muted-foreground">
          Use 8–128 characters. Changing the password signs this bidder out on
          all devices. Share the new password directly.
        </p>
        <PasswordEntry
          disabled={
            request.busy ||
            !request.ready ||
            (!!request.saved &&
              (request.saved.kind !== "set_bidder_password" ||
                !request.requiresPassword))
          }
          onSubmit={async (password, confirmation) => {
            const form = new FormData();
            form.set("user_id", person.id);
            completed(
              await request.submit("set_bidder_password", form, {
                password,
                confirmation,
              }),
            );
          }}
        />
      </div>
      <AccountRequestNotice
        request={request}
        pending={request.busy}
        retry={() => {
          void request.retry().then(completed);
        }}
      />
    </section>
  );
}
function PasswordReset({ person }: { person: Row<"profiles"> }) {
  const [confirmed, setConfirmed] = useState(false);
  const [pending, start] = useTransition();
  const request = useAccountRequest(true, `reset:${person.id}`);
  function completed(result: AccountActionResult) {
    if (result.error) toast.error(result.error);
    else if (result.operation?.status === "completed") {
      toast.success("Password reset to 123456");
      setConfirmed(false);
    }
  }
  return (
    <div className="space-y-3 border-t pt-4">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        Reset {person.email}&apos;s password to 123456. Their current password
        will stop working.
      </label>
      <Button
        variant="outline"
        disabled={!confirmed || pending || !!request.saved || !request.ready}
        onClick={() =>
          start(async () => {
            const form = new FormData();
            form.set("user_id", person.id);
            completed(await request.submit("reset_password", form));
          })
        }
      >
        Reset password
      </Button>
      <AccountRequestNotice
        request={request}
        pending={pending}
        retry={() => start(async () => completed(await request.retry()))}
      />
    </div>
  );
}
function CreateClientDialog() {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const request = useAccountRequest(open, "create-client");
  function completed(result: AccountActionResult) {
    if (result.error) toast.error(result.error);
    else if (result.operation?.status === "completed") {
      setOpen(false);
      toast.success("Client created");
      refreshWorkspace(router);
    }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Plus size={16} /> Add client
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create an approved client</DialogTitle>
          <DialogDescription>
            Initial password: 123456. No email is sent.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          action={(form) =>
            start(async () => {
              completed(await request.submit("create_client", form));
            })
          }
        >
          <fieldset
            disabled={pending || !!request.saved || !request.ready}
            className="space-y-4"
          >
            <Field
              label="Full name"
              name="display_name"
              required
              maxLength={100}
            />
            <Field label="Email address" name="email" type="email" required />
            <SaveButton pending={pending} label="Create client" />
          </fieldset>
        </form>
        <AccountRequestNotice
          request={request}
          pending={pending}
          retry={() => start(async () => completed(await request.retry()))}
        />
      </DialogContent>
    </Dialog>
  );
}
function ApprovalActions({ person }: { person: Row<"profiles"> }) {
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  function review(status: "approved" | "rejected") {
    start(async () => {
      const result = await reviewClient(person.id, status, reason);
      if (result.error) toast.error(result.error);
      else {
        setOpen(false);
        toast.success(
          status === "approved" ? "Client approved" : "Client rejected",
        );
        refreshWorkspace(router);
      }
    });
  }
  return (
    <div className="flex gap-2">
      {person.approval_status !== "approved" && (
        <Button size="sm" disabled={pending} onClick={() => review("approved")}>
          Approve
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline">
            {person.approval_status === "rejected"
              ? "Review rejection"
              : "Reject"}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review {person.display_name}</DialogTitle>
            <DialogDescription>
              The rejection reason is shown to the client. Rejecting an approved
              client also blocks their bidders.
            </DialogDescription>
          </DialogHeader>
          <Field
            label="Rejection reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            maxLength={1000}
          />
          <Button
            disabled={pending || !reason.trim()}
            onClick={() => review("rejected")}
          >
            Reject registration
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
export function People({
  data,
  initialTab = "active",
  highlightId,
}: {
  data: WorkspaceData;
  initialTab?: string;
  highlightId?: string;
}) {
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState(initialTab);
  useEffect(() => {
    if (!highlightId) return;
    window.requestAnimationFrame(() =>
      document
        .getElementById(`person-${highlightId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
  }, [highlightId]);
  const admin = data.profile.role === "admin";
  const matches = (p: Row<"profiles">) =>
    `${p.display_name} ${p.email} ${p.id}`
      .toLowerCase()
      .includes(search.toLowerCase());
  const biddersFor = (client: string) =>
    data.bidders
      .filter((b) =>
        data.workspaces.some(
          (w) => w.id === b.workspace_id && w.owner_id === client,
        ),
      )
      .map((b) => data.profiles.find((p) => p.id === b.user_id)!)
      .filter(Boolean);
  const visible = (p: Row<"profiles">) =>
    tab === "archived"
      ? p.archived
      : tab === "pending"
        ? p.role === "client" && p.approval_status !== "approved" && !p.archived
        : !p.archived;
  function personRow(p: Row<"profiles">) {
    const b = data.bidders.find((b) => b.user_id === p.id);
    return (
      <div
        id={`person-${p.id}`}
        key={p.id}
        className={`flex flex-wrap items-center gap-3 p-4 ${highlightId === p.id ? "bg-primary/5 ring-2 ring-inset ring-primary" : ""}`}
      >
        <div className="flex w-full min-w-0 items-center gap-3 sm:w-auto sm:flex-1">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
            {initials(p.display_name || p.email)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              {b ? (
                <Link className="hover:text-primary" href={`/users/${p.id}`}>
                  {p.display_name}
                </Link>
              ) : (
                p.display_name
              )}
            </p>
            <p className="break-all text-xs text-muted-foreground">{p.email}</p>
          </div>
        </div>
        {p.role === "client" && (
          <Badge variant="secondary" className="capitalize">
            {p.approval_status}
          </Badge>
        )}
        {p.archived && <Badge variant="outline">Archived</Badge>}
        {b && (
          <span className="text-xs text-muted-foreground">
            {b.default_rate_cents == null
              ? "Rate not set"
              : `${usd(b.default_rate_cents)} / bid`}
          </span>
        )}
        {admin && p.role === "client" && !p.archived && (
          <ApprovalActions person={p} />
        )}
        <EditPerson person={p} bidder={b} />
        {b && (
          <Button asChild size="icon" variant="ghost">
            <Link href={`/users/${p.id}`} aria-label={`View ${p.display_name}`}>
              <ArrowUpRight size={16} />
            </Link>
          </Button>
        )}
      </div>
    );
  }
  const clients = data.profiles.filter(
    (p) =>
      p.role === "client" &&
      (visible(p) ||
        (tab === "archived" && biddersFor(p.id).some((b) => b.archived))) &&
      (matches(p) || biddersFor(p.id).some(matches)),
  );
  const bidders = data.profiles.filter(
    (p) => p.role === "bidder" && visible(p) && matches(p),
  );
  // A workspace can belong to an admin (including a promoted client).
  // Such bidders must remain manageable even though they have no client group.
  const biddersWithoutClient = bidders.filter((p) => {
    const membership = data.bidders.find((b) => b.user_id === p.id);
    if (!membership) return false;
    const workspace = data.workspaces.find(
      (w) => w.id === membership.workspace_id,
    );
    return !data.profiles.some(
      (owner) => owner.id === workspace?.owner_id && owner.role === "client",
    );
  });
  return (
    <>
      <PageHeading
        eyebrow="THE PEOPLE BEHIND THE PROGRESS"
        title="Better work, together."
        description={
          admin
            ? "Clients, their bidders, and registrations awaiting your review."
            : "Manage your bidders, account access, and rates."
        }
      >
        {admin && <CreateClientDialog />}
        <CreateBidderDialog data={data} />
      </PageHeading>
      <AccountRecovery />
      <section className="panel overflow-hidden">
        <div className="flex flex-wrap justify-between gap-3 border-b p-4">
          <div className="flex flex-wrap gap-1">
            {(admin
              ? ["active", "pending", "archived"]
              : ["active", "archived"]
            ).map((t) => (
              <Button
                key={t}
                variant={tab === t ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={tab === t}
                onClick={() => setTab(t)}
                className="capitalize"
              >
                {t}
                {t === "pending"
                  ? ` (${data.profiles.filter((p) => p.role === "client" && !p.archived && p.approval_status === "pending").length})`
                  : ""}
              </Button>
            ))}
          </div>
          <div className="relative">
            <Search
              size={15}
              className="absolute left-3 top-2.5 text-muted-foreground"
            />
            <Input
              className="pl-9"
              aria-label="Search people"
              placeholder="Search name, email or ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        {admin ? (
          clients.length || biddersWithoutClient.length ? (
            <>
              {clients.map((p) => {
                const children = biddersFor(p.id);
                const w = data.workspaces.find((w) => w.owner_id === p.id);
                return (
                  <div className="border-b last:border-0" key={p.id}>
                    {personRow(p)}
                    <details
                      className="px-4 pb-4"
                      open={search ? true : undefined}
                    >
                      <summary className="cursor-pointer rounded-lg bg-secondary/50 px-4 py-3 text-sm font-medium">
                        {children.length} bidders under {p.display_name}
                      </summary>
                      <div className="ml-3 border-l pl-3">
                        {children
                          .filter(
                            (b) =>
                              (tab !== "archived" ||
                                p.archived ||
                                b.archived) &&
                              (matches(p) || matches(b)),
                          )
                          .map(personRow)}
                        {!children.length && (
                          <p className="p-4 text-sm text-muted-foreground">
                            No bidders yet.
                          </p>
                        )}
                        {w &&
                          !p.archived &&
                          p.approval_status === "approved" && (
                            <div className="p-3">
                              <CreateBidderDialog
                                data={data}
                                workspaceId={w.id}
                              />
                            </div>
                          )}
                      </div>
                    </details>
                  </div>
                );
              })}
              {biddersWithoutClient.length > 0 && (
                <section
                  aria-label="Bidders without a client"
                  className="border-t first:border-t-0"
                >
                  <div className="bg-secondary/50 px-4 py-3">
                    <h2 className="text-sm font-semibold">
                      Bidders without a client
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      Managed directly by an administrator.
                    </p>
                  </div>
                  {biddersWithoutClient.map(personRow)}
                </section>
              )}
            </>
          ) : (
            <EmptyState
              title="No matching people"
              description="Try another view or search."
            />
          )
        ) : bidders.length ? (
          bidders.map(personRow)
        ) : (
          <EmptyState
            title="No matching bidders"
            description="Add a bidder or change your search."
          />
        )}
      </section>
      {data.invitations.some((i) => !i.accepted_at) && (
        <section className="panel mt-6 p-5">
          <h2 className="mb-3 font-semibold">Unfinished account creation</h2>
          {data.invitations
            .filter((i) => !i.accepted_at)
            .map((i) => (
              <div
                key={i.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <p className="text-sm">{i.email}</p>
                <CreateBidderDialog data={data} invitation={i} />
              </div>
            ))}
        </section>
      )}
    </>
  );
}
