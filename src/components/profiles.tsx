"use client";
import { refreshWorkspace } from "@/lib/report-cache";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, MapPin, Plus } from "lucide-react";
import { toast } from "sonner";
import type { WorkspaceData } from "@/lib/data";
import { activeCandidateProfiles, activeResumes, activeWorkspaces } from "@/lib/active-items";
import type { Row } from "@/lib/database.types";
import {
  deleteCandidateProfile,
  previewCandidateRetention,
  saveCandidateProfile,
  saveCandidateProfileRules,
} from "@/app/(workspace)/actions";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import {
  EmptyState,
  Field,
  PageHeading,
  SaveButton,
  SelectField,
} from "./common";

function CandidateProfileDialog({
  data,
  candidate,
}: {
  data: WorkspaceData;
  candidate?: Row<"candidate_profiles">;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const workspaces = activeWorkspaces(data);
  const [selectedWorkspace, setWorkspace] = useState(candidate?.workspace_id ?? workspaces[0]?.id ?? "");
  const workspace = workspaces.some((item) => item.id === selectedWorkspace) ? selectedWorkspace : "";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={candidate ? "outline" : "default"} disabled={!workspaces.length}>
          {!candidate && <Plus size={16} />}
          {candidate ? "Edit profile details" : "New candidate profile"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {candidate
              ? "Edit shared candidate profile"
              : "Create candidate profile"}
          </DialogTitle>
          <DialogDescription>
            These details are shared with every bidder assigned to this profile.
            Email, phone, and PDF belong to each assignment.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          action={(form) =>
            start(async () => {
              if (!workspace) { toast.error("Choose an active workspace."); return; }
              const result = await saveCandidateProfile(form);
              if (result.error) toast.error(result.error);
              else {
                toast.success("Candidate profile saved");
                setOpen(false);
                refreshWorkspace(router);
              }
            })
          }
        >
          <input type="hidden" name="id" value={candidate?.id ?? ""} />
          {data.profile.role === "admin" && (
            <SelectField
              label="Client workspace"
              name="workspace_id"
              value={workspace}
              onChange={(event) => setWorkspace(event.target.value)}
              required
            >
              <option value="" disabled>Choose a workspace</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </SelectField>
          )}
          <Field
            label="Profile ID"
            name="identifier"
            required
            maxLength={100}
            defaultValue={candidate?.identifier}
            placeholder="ENG-01"
          />
          <Field
            label="Candidate name"
            name="candidate_name"
            required
            maxLength={100}
            defaultValue={candidate?.candidate_name}
          />
          <Field
            label="Postal address"
            name="address"
            defaultValue={candidate?.address}
          />
          <Field
            label="Professional links"
            name="links"
            defaultValue={candidate?.links}
            placeholder="LinkedIn, portfolio, GitHub"
          />
          <label className="block space-y-2 text-xs font-medium">
            Application instructions
            <Textarea
              name="instructions"
              rows={5}
              defaultValue={candidate?.instructions}
              placeholder="Experience, preferences, and details to use when applying"
            />
          </label>
          <div className="flex justify-end">
            <SaveButton pending={pending} />
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProfileRulesDialog({
  candidate,
}: {
  candidate: Row<"candidate_profiles">;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const [companyLimit, setCompanyLimit] = useState(
    String(candidate.max_bids_per_company),
  );
  const [retention, setRetention] = useState(
    candidate.retention_months === null
      ? ""
      : String(candidate.retention_months),
  );
  const [companies, setCompanies] = useState(
    candidate.restricted_companies.join("\n"),
  );
  const [roles, setRoles] = useState(candidate.restricted_roles.join("\n"));
  const [links, setLinks] = useState(candidate.restricted_links.join("\n"));
  const rules = (value: string) =>
    value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Bid restrictions</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bid restrictions and retention</DialogTitle>
          <DialogDescription>
            Rules apply to all bidders assigned to {candidate.identifier}.
            Substrings match literally without case sensitivity. New profiles
            default to two calendar months of retention.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          action={(form) => {
            const nextRetention = String(form.get("retention") ?? "").trim();
            const retentionMonths = nextRetention
              ? Number(nextRetention)
              : null;
            if (
              retentionMonths !== null &&
              (!Number.isInteger(retentionMonths) ||
                retentionMonths < 1 ||
                retentionMonths > 120)
            ) {
              toast.error(
                "Retention must be between 1 and 120 months, or blank to disable it.",
              );
              return;
            }
            start(async () => {
              let confirmedEligible: number | null = null;
              if (
                retentionMonths !== null &&
                (candidate.retention_months === null ||
                  retentionMonths < candidate.retention_months)
              ) {
                const preview = await previewCandidateRetention(
                  candidate.id,
                  retentionMonths,
                );
                if (preview.error || !preview.data) {
                  toast.error(
                    preview.error ?? "Could not check affected bids.",
                  );
                  return;
                }
                if (preview.data.eligible > 0) {
                  if (
                    !window.confirm(
                      `This change will make ${preview.data.eligible} applied bids eligible for permanent deletion. Daily reporting totals will be retained. Continue?`,
                    )
                  )
                    return;
                  confirmedEligible = preview.data.eligible;
                }
              }
              const result = await saveCandidateProfileRules({
                profile: candidate.id,
                companyLimit: Number(companyLimit),
                retentionMonths,
                companies: rules(companies),
                roles: rules(roles),
                links: rules(links),
                confirmedEligible,
              });
              if (result.error) toast.error(result.error);
              else {
                toast.success("Profile restrictions saved");
                setOpen(false);
                refreshWorkspace(router);
              }
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Maximum bids per company"
              type="number"
              min="1"
              max="1000"
              value={companyLimit}
              onChange={(event) => setCompanyLimit(event.target.value)}
              required
            />
            <Field
              label="Retention in calendar months (blank disables)"
              name="retention"
              type="number"
              min="1"
              max="120"
              value={retention}
              onChange={(event) => setRetention(event.target.value)}
            />
          </div>
          <label className="block space-y-2 text-xs font-medium">
            Restricted company substrings
            <Textarea
              value={companies}
              onChange={(event) => setCompanies(event.target.value)}
              rows={3}
              placeholder="One literal substring per line"
            />
          </label>
          <label className="block space-y-2 text-xs font-medium">
            Restricted role title substrings
            <Textarea
              value={roles}
              onChange={(event) => setRoles(event.target.value)}
              rows={3}
              placeholder="One literal substring per line"
            />
          </label>
          <label className="block space-y-2 text-xs font-medium">
            Restricted job link substrings
            <Textarea
              value={links}
              onChange={(event) => setLinks(event.target.value)}
              rows={3}
              placeholder="One literal substring per line"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Repeated or blank rules are removed. Lowering the limit blocks new
            bids until the profile is under that limit. Trashed bids still count
            toward restrictions.
          </p>
          <div className="flex justify-end">
            <SaveButton pending={pending} label="Save rules" />
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CandidateProfileLibrary({ data }: { data: WorkspaceData }) {
  const [selected, setSelected] = useState<string>();
  const [pending, start] = useTransition();
  const router = useRouter();
  const managers = data.profile.role !== "bidder";
  const resumes = activeResumes(data);
  const list = activeCandidateProfiles(data).filter((candidate) => {
    const workspace = data.workspaces.find(
      (w) => w.id === candidate.workspace_id,
    );
    return (
      !candidate.archived &&
      (data.profile.role === "admin" || workspace?.owner_id === data.profile.id)
    );
  });
  const active = list.find((candidate) => candidate.id === selected);
  return (
    <>
      <PageHeading
        eyebrow="SHARED CANDIDATE DETAILS"
        title="Shared candidate profiles."
        description="Maintain a candidate once, then assign their profile to each bidder who needs it."
      >
        {managers && <CandidateProfileDialog data={data} />}
      </PageHeading>
      {!list.length ? (
        <section className="panel">
          <EmptyState
            title="Create your first candidate profile"
            description="Profile details are shared. Contact information and a private PDF are added separately for each bidder assignment."
          />
        </section>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {list.map((candidate) => {
            const assignments = resumes.filter(
              (resume) => resume.profile_id === candidate.id,
            );
            return (
              <button
                type="button"
                key={candidate.id}
                onClick={() => setSelected(candidate.id)}
                className="panel min-w-0 p-6 text-left transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-primary"
              >
                <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
                  <Badge
                    className="max-w-full whitespace-normal [overflow-wrap:anywhere]"
                    variant={candidate.archived ? "outline" : "secondary"}
                  >
                    {candidate.archived ? "Archived" : candidate.identifier}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {assignments.length} bidder
                    {assignments.length === 1 ? "" : "s"}
                  </span>
                </div>
                <h2 className="text-lg font-semibold">
                  {candidate.candidate_name}
                </h2>
                <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                  <MapPin size={14} />{" "}
                  {candidate.address || "Address not added"}
                </p>
                <p className="mt-5 border-t pt-4 text-xs text-muted-foreground">
                  {assignments.length
                    ? assignments
                        .map(
                          (assignment) =>
                            data.profiles.find(
                              (person) => person.id === assignment.bidder_id,
                            )?.display_name ?? "Assigned bidder",
                        )
                        .join(" · ")
                    : "Not assigned yet"}
                </p>
              </button>
            );
          })}
        </div>
      )}
      <Dialog
        open={!!active}
        onOpenChange={(open) => !open && setSelected(undefined)}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          {active && (
            <>
              <DialogHeader>
                <DialogTitle>{active.candidate_name}</DialogTitle>
                <DialogDescription className="[overflow-wrap:anywhere]">
                  {active.identifier} · Shared profile details
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-5">
                <div className="flex items-center justify-between gap-3">
                  <Badge variant={active.archived ? "outline" : "secondary"}>
                    {active.archived ? "Archived" : "Active profile"}
                  </Badge>
                  {managers && (
                    <div className="flex gap-2">
                      <ProfileRulesDialog candidate={active} />
                      <CandidateProfileDialog data={data} candidate={active} />
                    </div>
                  )}
                </div>
                <div>
                  <p className="eyebrow mb-2">POSTAL ADDRESS</p>
                  <p className="whitespace-pre-wrap text-sm">
                    {active.address || "Not provided"}
                  </p>
                </div>
                <div>
                  <p className="eyebrow mb-2">PROFESSIONAL LINKS</p>
                  <p className="whitespace-pre-wrap break-all text-sm">
                    {active.links || "Not provided"}
                  </p>
                </div>
                <div>
                  <p className="eyebrow mb-2">APPLICATION INSTRUCTIONS</p>
                  <p className="whitespace-pre-wrap rounded-lg bg-background p-4 text-sm leading-6">
                    {active.instructions || "No additional instructions."}
                  </p>
                </div>
                <div className="border-t pt-4">
                  <h3 className="mb-3 font-semibold">Bidder assignments</h3>
                  <div className="divide-y">
                    {resumes
                      .filter((resume) => resume.profile_id === active.id)
                      .map((assignment) => (
                        <div
                          key={assignment.id}
                          className="grid gap-1 py-3 text-sm sm:grid-cols-3"
                        >
                          <span>
                            {data.profiles.find(
                              (person) => person.id === assignment.bidder_id,
                            )?.display_name ?? "Assigned bidder"}
                          </span>
                          <span className="break-all text-muted-foreground">
                            {assignment.email}
                          </span>
                          <span className="text-muted-foreground">
                            {assignment.phone}
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
                {managers && (
                  <div className="flex justify-end border-t pt-4">
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        start(async () => {
                          const assignments = data.resumes.filter((r) => r.profile_id === active.id);
                          const count = assignments.reduce((total,r) => total + (data.bidCounts[r.id] ?? 0),0);
                          if (!window.confirm(`Permanently delete this candidate profile, all ${assignments.length} assignments, ${count} associated bids, their history and files? This cannot be undone.`)) return;
                          const result = await deleteCandidateProfile(active.id);
                          if (result.error) toast.error(result.error);
                          else {
                            toast.success(result.data?.status.pendingFiles ? "Profile deleted. File cleanup pending; retry is automatic." : "Profile permanently deleted");
                            setSelected(undefined);
                            refreshWorkspace(router);
                          }
                        })
                      }
                    >
                      <Trash2 size={15} /> Delete profile permanently
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
