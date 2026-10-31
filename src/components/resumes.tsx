"use client";
import { refreshWorkspace } from "@/lib/report-cache";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, FileText, Search, Mail, Phone, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { WorkspaceData } from "@/lib/data";
import type { ResumeRow } from "@/lib/workspace-types";
import { usd, effectiveRate, validateUpload } from "@/lib/domain";
import { saveResumeAssignment, deleteResumeAssignment } from "@/app/(workspace)/actions";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "./ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "./ui/sheet";
import { PageHeading, Field, SelectField, SaveButton, EmptyState, FileButton } from "./common";
import { FileUpload, uploadVerifiedFile } from "./file-upload";

export function ResumeDialog({ data, resume, bidderId }: { data: WorkspaceData; resume?: ResumeRow; bidderId?: string }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [bidder, setBidder] = useState(resume?.bidder_id ?? bidderId ?? data.bidders.find((b) => !b.archived)?.user_id ?? "");
  const [profileId, setProfileId] = useState(resume?.profile_id ?? "");
  const [savedAssignment, setSavedAssignment] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ phase: string; value: number } | null>(null);
  const [uploadError, setUploadError] = useState("");
  const router = useRouter();
  const membership = data.bidders.find((b) => b.user_id === bidder);
  const selectedProfile = data.candidateProfiles.find((p) => p.id === profileId);
  const hasBidHistory = !!resume && (data.bidCounts[resume.id] ?? 0) > 0;
  const needsNewPdf = !resume?.file_id || resume.bidder_id !== bidder;
  const profiles = data.candidateProfiles.filter((p) => (!p.archived || p.id === resume?.profile_id) && (!membership || p.workspace_id === membership.workspace_id));
  return <Dialog open={open} onOpenChange={(next) => { if (pending || uploading) return; setOpen(next); if (!next) { setSavedAssignment(""); setFile(null); setUploadError(""); } }}>
    <DialogTrigger asChild><Button variant={resume ? "outline" : "default"} size={resume ? "sm" : "default"} disabled={pending || uploading || !data.bidders.some((b) => !b.archived) || !data.candidateProfiles.some((p) => !p.archived)}>{!resume && <Plus size={16} />} {resume ? "Edit assignment" : "Assign profile"}</Button></DialogTrigger>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>{resume ? "Edit bidder assignment" : "Assign a profile to a bidder"}</DialogTitle><DialogDescription>Shared candidate details live in Profiles. Each bidder assignment has its own contact details and private PDF.</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        start(async () => {
        setUploadError("");
        if (needsNewPdf && !file) { setUploadError("Choose a PDF resume file for this bidder before saving the assignment."); return; }
        if (file) {
          try { validateUpload("resume", file.type, file.size); }
          catch (error) { setUploadError(error instanceof Error ? error.message : "Choose a valid PDF."); return; }
        }
        const result = await saveResumeAssignment({
          id: savedAssignment || resume?.id || undefined,
          profileId,
          bidderId: bidder,
          email: String(form.get("email") ?? ""),
          phone: String(form.get("phone") ?? ""),
          rate: String(form.get("rate") ?? ""),
        });
        if (result.error || !result.data) { const message = result.error ?? "Could not save assignment."; setUploadError(message); toast.error(message); return; }
        const id = result.data as string;
        setSavedAssignment(id);
        if (file) {
          setUploading(true);
          try {
            await uploadVerifiedFile("resume", id, file, (phase, value) => setUploadProgress({ phase, value }));
          } catch (error) {
            const message = error instanceof Error ? error.message : "Resume upload failed. Retry in this dialog.";
            setUploadError(message);
            toast.error(message);
            setUploading(false);
            setUploadProgress(null);
            refreshWorkspace(router);
            return;
          }
          setUploading(false);
          setUploadProgress(null);
        }
        toast.success(resume?.file_id && !file ? "Assignment saved" : "Assignment and resume saved");
        refreshWorkspace(router);
        setOpen(false);
        setSavedAssignment("");
        setFile(null);
        });
      }}>
        <input type="hidden" name="id" value={savedAssignment || resume?.id || ""} />
        <SelectField label="Assigned bidder" name="bidder_id" value={bidder} disabled={hasBidHistory} onChange={(e) => { setBidder(e.target.value); setProfileId(""); }} required>
          <option value="" disabled>Choose a bidder</option>
          {data.bidders.filter((b) => !b.archived || b.user_id === bidder).map((b) => <option key={b.user_id} value={b.user_id}>{data.profiles.find((p) => p.id === b.user_id)?.display_name ?? "Bidder"}</option>)}
        </SelectField>
        <SelectField label="Candidate profile" name="profile_id" value={profileId} disabled={hasBidHistory} onChange={(e) => setProfileId(e.target.value)} required>
          <option value="" disabled>Choose a shared profile</option>
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.identifier} · {p.candidate_name}</option>)}
        </SelectField>
        {hasBidHistory && <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">Profile and bidder are locked because this assignment has bid history, including applications in Trash. Contact details, rate, and PDF can still be updated.</p>}
        {resume && resume.bidder_id !== bidder && <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">Changing the assigned bidder clears the previous bidder’s PDF. Upload a PDF for the new bidder to complete this assignment.</p>}
        {selectedProfile && <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">Shared profile: {selectedProfile.candidate_name}. Address, links, and instructions are managed on the Profiles page.</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email address" name="email" type="email" required defaultValue={resume?.email} />
          <Field label="Phone number" name="phone" type="tel" required defaultValue={resume?.phone} />
        </div>
        <Field label="Rate override per bid (USD)" name="rate" type="number" min="0" step="0.01" defaultValue={resume?.rate_override_cents != null ? resume.rate_override_cents / 100 : ""} placeholder={membership?.default_rate_cents != null ? `Inherit ${usd(membership.default_rate_cents)}` : "Use bidder default"} />
        <div className="space-y-2 rounded-xl border border-dashed p-4">
          <label className="block text-sm font-medium" htmlFor="assignment-resume-file">Resume PDF {!needsNewPdf && <span className="text-xs font-normal text-muted-foreground">(optional replacement)</span>}</label>
          <input ref={fileInput} id="assignment-resume-file" type="file" accept="application/pdf" required={needsNewPdf} disabled={pending || uploading} aria-label="Choose resume file" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setUploadError(""); }} className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-xs file:font-medium" />
          {file && <div className="flex items-center justify-between text-xs text-muted-foreground"><span className="truncate">{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB</span><Button type="button" variant="ghost" size="sm" disabled={pending || uploading} onClick={() => { setFile(null); if (fileInput.current) fileInput.current.value = ""; setUploadError(""); }}>Remove</Button></div>}
          {!file && resume?.file_id && !needsNewPdf && <p className="text-xs text-muted-foreground">Current PDF stays active if a replacement upload fails.</p>}
          <p className="text-xs text-muted-foreground">PDF only, up to 10 MB. The assignment becomes available for bids after verification.</p>
          {uploadProgress && <div role="status" className="text-xs">{uploadProgress.phase}… {uploadProgress.value}%</div>}
          {uploadError && <p role="alert" className="text-xs text-destructive">{uploadError}</p>}
        </div>
        <div className="flex justify-end"><SaveButton pending={pending || uploading} label={file ? "Assign profile and upload PDF" : needsNewPdf ? "Choose a PDF to continue" : "Save assignment"} /></div>
      </form>
    </DialogContent>
  </Dialog>;
}

export function ResumeLibrary({ data, bidderId, embedded = false }: { data: WorkspaceData; bidderId?: string; embedded?: boolean }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string>();
  const [pending, start] = useTransition();
  const router = useRouter();
  const canEdit = data.profile.role !== "bidder";
  const list = data.resumes.filter((r) => {
    const candidate = data.candidateProfiles.find((p) => p.id === r.profile_id);
    return (!bidderId || r.bidder_id === bidderId) && (!r.archived && !candidate?.archived) && `${candidate?.identifier ?? ""} ${candidate?.candidate_name ?? ""} ${r.email}`.toLowerCase().includes(search.toLowerCase());
  });
  const active = data.resumes.find((r) => r.id === selected);
  const candidate = active && data.candidateProfiles.find((p) => p.id === active.profile_id);
  return <>
    {!embedded && <PageHeading eyebrow="BIDDER SPECIFIC RESUME ASSIGNMENTS" title="Your resume library." description="Assign shared candidate profiles to bidders with individual contact details and private resumes.">{canEdit && <ResumeDialog data={data} bidderId={bidderId} />}</PageHeading>}
    {embedded && <div className="mb-5 flex items-center justify-between"><h2 className="text-lg font-semibold">Resume assignments</h2>{canEdit && <ResumeDialog data={data} bidderId={bidderId} />}</div>}
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3"><div className="relative w-full sm:w-80"><Search className="absolute left-3 top-2.5 text-muted-foreground" size={15} /><Input aria-label="Search resumes" className="bg-card pl-9" placeholder="Search profiles or email…" value={search} onChange={(e) => setSearch(e.target.value)} /></div></div>
    {!list.length ? <div className="panel"><EmptyState title="A place for every assignment" description={canEdit ? "Create a shared candidate profile, then assign it to a bidder with their contact details and PDF." : "Your client will assign candidate profiles and resumes here. Check back soon."} /></div> : <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">{list.map((r) => {
      const profile = data.candidateProfiles.find((p) => p.id === r.profile_id);
      const bidder = data.bidders.find((b) => b.user_id === r.bidder_id);
      const rate = effectiveRate(bidder?.default_rate_cents ?? null, r.rate_override_cents ?? null);
      return <button key={r.id} onClick={() => setSelected(r.id)} className="panel group p-6 text-left transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-primary"><div className="mb-5 flex items-start justify-between"><span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><FileText size={21} /></span><Badge variant="outline" className="text-[10px]">{r.archived || profile?.archived ? "Archived" : !r.file_id ? "Needs PDF" : profile?.identifier ?? "Profile"}</Badge></div><h3 className="text-base font-semibold group-hover:text-primary">{profile?.candidate_name ?? "Candidate profile"}</h3><p className="mt-1 text-xs text-muted-foreground">{data.profiles.find((p) => p.id === r.bidder_id)?.display_name ?? "Assigned bidder"}</p><div className="my-5 space-y-2.5 text-xs text-muted-foreground"><p className="flex items-center gap-2 truncate"><Mail size={13} />{r.email || "No email added"}</p><p className="flex items-center gap-2"><Phone size={13} />{r.phone || "No phone added"}</p></div><div className="flex items-center justify-between border-t pt-4"><span className="text-xs text-muted-foreground">{data.bidCounts[r.id] ?? 0} bids tracked</span>{canEdit && <span className="text-sm font-semibold">{rate === null ? "Rate not set" : <>{usd(rate)}<span className="ml-1 text-[10px] font-normal text-muted-foreground">/ bid</span></>}</span>}</div></button>;
    })}</div>}
    <Sheet open={!!active} onOpenChange={(open) => { if (!open) setSelected(undefined); }}><SheetContent className="w-full overflow-y-auto p-6 sm:max-w-lg">{active && candidate && <><SheetHeader className="p-0"><SheetTitle>{candidate.candidate_name}</SheetTitle><SheetDescription>{candidate.identifier} · Bidder assignment</SheetDescription></SheetHeader><div className="mt-6 space-y-5"><div className="flex items-center justify-between"><Badge variant="secondary">{active.archived || candidate.archived ? "Archived" : "Active assignment"}</Badge>{canEdit && !active.archived && !candidate.archived && <ResumeDialog data={data} resume={active} />}</div><div><p className="eyebrow mb-2">EMAIL</p><p className="break-words text-sm">{active.email || "Not provided"}</p></div><div><p className="eyebrow mb-2">PHONE</p><p className="text-sm">{active.phone || "Not provided"}</p></div><div><p className="eyebrow mb-2">POSTAL ADDRESS</p><p className="whitespace-pre-wrap text-sm">{candidate.address || "Not provided"}</p></div><div><p className="eyebrow mb-2">PROFESSIONAL LINKS</p><p className="whitespace-pre-wrap text-sm">{candidate.links || "Not provided"}</p></div><div><p className="eyebrow mb-2">APPLICATION INSTRUCTIONS</p><p className="whitespace-pre-wrap rounded-lg bg-background p-4 text-sm leading-6">{candidate.instructions || "No additional instructions."}</p></div><div className="space-y-3 border-t pt-5"><h3 className="font-semibold">Resume document</h3>{active.file_id ? <FileButton id={active.file_id} label="Open resume" /> : <p className="text-xs text-muted-foreground">No document uploaded yet.</p>}{canEdit && !active.archived && <FileUpload kind="resume" target={active.id} onUploaded={() => refreshWorkspace(router)} />}</div>{canEdit && <Button variant="outline" className="w-full" disabled={pending} onClick={() => start(async () => { if (!window.confirm(`Permanently delete this assignment, its ${data.bidCounts[active.id] ?? 0} bids, history, screenshots and resume PDF? The shared candidate profile and other assignments will remain. This cannot be undone.`)) return; const result = await deleteResumeAssignment(active.id); if (result.error) toast.error(result.error); else { toast.success(result.data?.status.pendingFiles ? "Assignment deleted. File cleanup pending; retry is automatic." : "Assignment permanently deleted"); setSelected(undefined); refreshWorkspace(router); } })}><Trash2 size={15} />Delete assignment permanently</Button>}</div></>}</SheetContent></Sheet>
  </>;
}
