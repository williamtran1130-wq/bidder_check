"use client";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Search, ArrowUpRight, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import type { WorkspaceData } from "@/lib/data";
import type { Row } from "@/lib/database.types";
import type { BidderRow } from "@/lib/workspace-types";
import { usd, initials } from "@/lib/domain";
import {
  createBidder,
  updateBidder,
  updateClient,
  createClientAccount,
  reviewClient,
  resetManagedPassword,
} from "@/app/(workspace)/actions";
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
              const result = await createBidder(form);
              if (result.error) toast.error(result.error);
              else {
                toast.success(
                  "Bidder account created. Initial password: 123456",
                );
                setOpen(false);
                router.refresh();
              }
            })
          }
        >
          <SelectField
            label="Workspace"
            name="workspace_id"
            defaultValue={
              invitation?.workspace_id ?? workspaceId ?? data.workspaces[0]?.id
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
        </form>
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
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Manage
        </Button>
      </DialogTrigger>
      <DialogContent>
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
              const result = await (bidder
                ? updateBidder(form)
                : updateClient(form));
              if (result.error) toast.error(result.error);
              else {
                toast.success("Account updated");
                setOpen(false);
                router.refresh();
              }
            })
          }
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
        </form>
        <PasswordReset person={person} />
      </DialogContent>
    </Dialog>
  );
}
function PasswordReset({ person }: { person: Row<"profiles"> }) {
  const [confirmed, setConfirmed] = useState(false);
  const [pending, start] = useTransition();
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
        disabled={!confirmed || pending}
        onClick={() =>
          start(async () => {
            const result = await resetManagedPassword(person.id, confirmed);
            if (result.error) toast.error(result.error);
            else {
              toast.success("Password reset to 123456");
              setConfirmed(false);
            }
          })
        }
      >
        Reset password
      </Button>
    </div>
  );
}
function CreateClientDialog() {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
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
              const result = await createClientAccount(form);
              if (result.error) toast.error(result.error);
              else {
                setOpen(false);
                toast.success("Client created");
                router.refresh();
              }
            })
          }
        >
          <Field
            label="Full name"
            name="display_name"
            required
            maxLength={100}
          />
          <Field label="Email address" name="email" type="email" required />
          <SaveButton pending={pending} label="Create client" />
        </form>
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
        router.refresh();
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
