"use client";
import { PageLoading } from "./page-loading";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Popover as PopoverPrimitive } from "radix-ui";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import {
  ColumnDef,
  ColumnFiltersState,
  getCoreRowModel,
  SortingState,
  useReactTable,
} from "@tanstack/react-table";
import {
  Plus,
  Search,
  ArrowUpDown,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  BriefcaseBusiness,
  SlidersHorizontal,
  Clock,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import type { WorkspaceData } from "@/lib/data";
import type { Row } from "@/lib/database.types";
import { usd, BID_TIMEZONE } from "@/lib/domain";
import {
  saveBid,
  trashBid,
  reconcileBidTargets,
  unapplyBid,
  reviewBidAction,
  resubmitBidAction,
  setBidInterviewAction,
} from "@/app/(workspace)/actions";
import { getBidRows, getBidHistory } from "@/lib/read-client";
import { bidReadKey, actorReadScope } from "@/lib/read-keys";
import { ReadRequests, seedFor, type ReadSeed } from "@/lib/read-state";
import type { BidListResult, BidListLoadResult } from "@/lib/bid-list";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "./ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "./ui/sheet";
import {
  PageHeading,
  Field,
  SelectField,
  SaveButton,
  FileButton,
  AppliedBadge,
} from "./common";
import { ScreenshotCell } from "./screenshot-cell";
import { AppliedIpLocationCell } from "./applied-ip-location-cell";
import { FileUpload } from "./file-upload";
import { BulkBidToolbar } from "./bulk-bid-toolbar";
import { BidGrid } from "./bid-grid";
import { SheetsImport, type ImportResult } from "./sheets-import";
import type { BidRow } from "@/lib/workspace-types";
import {
  calendarToday,
  shiftCalendarDate,
  type CalendarPeriod,
} from "@/lib/calendar-period";
import { PeriodSelector } from "./period-selector";
import {
  buildResumeOptions,
  compatibleResume,
  filterResumeOptions,
} from "@/lib/resume-options";
import { ResumeSelector } from "./resume-selector";
import { UploadHistory } from "./upload-details";
type Bid = BidRow;
async function bidAction<T>(
  run: () => Promise<T>,
): Promise<T | { error: string; data?: never }> {
  try {
    return await run();
  } catch (error) {
    // Framework navigation must reach Next instead of becoming a form error.
    const digest =
      error && typeof error === "object" && "digest" in error
        ? String(error.digest)
        : "";
    if (
      digest.startsWith("NEXT_REDIRECT;") ||
      digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;") ||
      (error instanceof Error && error.message === "NEXT_REDIRECT")
    )
      throw error;
    return {
      error:
        "Could not complete this action. Check the current status before retrying; your draft is kept.",
    };
  }
}
export function BidDialog({
  data,
  bid,
  bidderId,
}: {
  data: WorkspaceData;
  bid?: Bid;
  bidderId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [saveError, setSaveError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const router = useRouter();
  const assignmentLabels = useMemo(() => buildResumeOptions(data), [data]);
  const active = data.resumes.filter(
    (r) =>
      (!(bid?.bidder_id ?? bidderId) ||
        r.bidder_id === (bid?.bidder_id ?? bidderId)) &&
      ((!r.archived &&
        !!r.file_id &&
        !data.bidders.find((b) => b.user_id === r.bidder_id)?.archived) ||
        r.id === bid?.resume_id),
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setBlocked(false);
        setSaveError("");
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant={bid ? "outline" : "default"}
          size={bid ? "sm" : "default"}
          disabled={!active.length}
        >
          {!bid && <Plus size={16} />} {bid ? "Edit details" : "Add bid"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {bid ? "Keep the details up to date" : "One more opportunity."}
          </DialogTitle>
          <DialogDescription>
            {bid
              ? "Update this job’s details and availability."
              : "Save a job now. Add your application screenshot when you’re done."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            start(async () => {
              setBlocked(false);
              const result = await bidAction(() => saveBid(form));
              if (result.error) {
                setSaveError(result.error);
                toast.error(result.error);
              } else if (result.data?.status === "blocked") {
                setSaveError("");
                setBlocked(true);
              } else if (result.data?.status === "saved") {
                setSaveError("");
                toast.success(bid ? "Bid updated" : "Opportunity added");
                setOpen(false);
                router.refresh();
              }
            });
          }}
        >
          {blocked && (
            <p role="status" className="rounded-lg bg-muted p-3 text-sm">
              Blocked
            </p>
          )}
          {saveError &&
            !["url", "company", "role_name", "resume_id"].some((field) => {
              if (field === "url") return /url|link|job/i.test(saveError);
              if (field === "company") return /company|limit/i.test(saveError);
              if (field === "role_name")
                return /role|application for this job/i.test(saveError);
              return /profile|resume/i.test(saveError);
            }) && (
              <p
                role="alert"
                className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
              >
                {saveError}
              </p>
            )}
          <input type="hidden" name="id" value={bid?.id ?? ""} />
          {bid?.first_applied_at ? (
            <>
              <input type="hidden" name="resume_id" value={bid.resume_id} />
              <p className="rounded-lg bg-secondary p-3 text-xs">
                Resume: {assignmentLabels.get(bid.resume_id)?.label} · Locked
                after first application
              </p>
            </>
          ) : (
            <SelectField
              label="Resume profile"
              name="resume_id"
              required
              defaultValue={bid?.resume_id ?? active[0]?.id}
            >
              {active.map((r) => (
                <option key={r.id} value={r.id}>
                  {assignmentLabels.get(r.id)?.label}
                </option>
              ))}
            </SelectField>
          )}
          <div>
            <Field
              label="Job URL"
              name="url"
              type="url"
              required
              placeholder="https://company.com/careers/…"
              defaultValue={bid?.url}
              onChange={() => setSaveError("")}
            />
            {/url|link|job/i.test(saveError) && (
              <p role="alert" className="mt-1 text-xs text-destructive">
                {saveError}
              </p>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Field
                label="Company name"
                name="company"
                required
                defaultValue={bid?.company}
                placeholder="Acme"
                onChange={() => setSaveError("")}
              />
              {/company|limit/i.test(saveError) && (
                <p role="alert" className="mt-1 text-xs text-destructive">
                  {saveError}
                </p>
              )}
            </div>
            <div>
              <Field
                label="Role name"
                name="role_name"
                required
                defaultValue={bid?.role_name}
                placeholder="Senior Software Engineer"
                onChange={() => setSaveError("")}
              />
              {/role|application for this job/i.test(saveError) && (
                <p role="alert" className="mt-1 text-xs text-destructive">
                  {saveError}
                </p>
              )}
            </div>
            <SelectField
              label="Work arrangement"
              name="arrangement"
              defaultValue={bid?.arrangement ?? "remote"}
            >
              <option value="remote">Remote</option>
              <option value="hybrid">Hybrid</option>
              <option value="onsite">Onsite</option>
            </SelectField>
            <SelectField
              label="Job status"
              name="job_status"
              defaultValue={bid?.job_status ?? "open"}
            >
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </SelectField>
            <Field
              label="Jobsite source"
              name="source"
              list="job-sources"
              required
              defaultValue={bid?.source}
              placeholder="LinkedIn, Indeed, company site…"
            />
          </div>
          <datalist id="job-sources">
            {[
              "LinkedIn",
              "Indeed",
              "Glassdoor",
              "Wellfound",
              "Company website",
              "Other",
            ].map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <div className="flex justify-end">
            <SaveButton
              pending={pending}
              label={bid ? "Save changes" : "Add opportunity"}
            />
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
export function BidWorkspace({
  data,
  embedded = false,
  bidderId,
  initial,
}: {
  data: WorkspaceData;
  embedded?: boolean;
  bidderId?: string;
  initial?: ReadSeed<BidListResult>;
}) {
  // A new auth scope must never inherit another user's review cache or controls.
  return (
    <BidWorkspaceContent
      key={`${actorReadScope(data)}:${bidderId ?? ""}`}
      data={data}
      embedded={embedded}
      bidderId={bidderId}
      initial={initial}
    />
  );
}
function BidWorkspaceContent({
  data,
  embedded = false,
  bidderId,
  initial,
}: {
  data: WorkspaceData;
  embedded?: boolean;
  bidderId?: string;
  initial?: ReadSeed<BidListResult>;
}) {
  const canReview =
    (data.profile.role === "client" || data.profile.role === "admin") &&
    data.profile.approval_status === "approved" &&
    !data.profile.archived;
  const assignmentLabels = useMemo(() => buildResumeOptions(data), [data]);
  const assignments = useMemo(
    () => [...assignmentLabels.values()],
    [assignmentLabels],
  );
  const resumeById = useMemo(
    () => new Map(data.resumes.map((item) => [item.id, item])),
    [data.resumes],
  );
  const profileById = useMemo(
    () => new Map(data.candidateProfiles.map((item) => [item.id, item])),
    [data.candidateProfiles],
  );
  const [checked, setChecked] = useState<
    Record<string, { version: number; applied: boolean }>
  >({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [paste, setPaste] = useState<string | null>(null);
  const importLauncher = useRef<HTMLButtonElement | null>(null);
  const editing = useRef(false);
  const deferredRefresh = useRef(false);
  const [isEditing, setIsEditing] = useState(false);
  const requests = useRef(new ReadRequests<BidListLoadResult>());
  const historyRequest = useRef(0);
  const seedEligible = useRef(true);
  const [preferencesReady, setPreferencesReady] = useState(false);
  function refreshSnapshot() {
    requests.current.invalidate();
    if (editing.current) deferredRefresh.current = true;
    else setRevision((n) => n + 1);
  }
  function editingChanged(value: boolean) {
    const wasEditing = editing.current;
    editing.current = value;
    setIsEditing(value);
    if (!value) {
      setToday(formatInTimeZone(new Date(), BID_TIMEZONE, "yyyy-MM-dd"));
      setDebouncedSearch(search);
    }
    // Ending an edit also reloads conflicts/cancelled drafts: another action
    // may have changed result membership or evidence while the grid was locked.
    if (!value && (deferredRefresh.current || wasEditing)) {
      deferredRefresh.current = false;
      refreshSnapshot();
    }
  }
  function imported(result: ImportResult) {
    setPaste(null);
    setSearch("");
    setStatus("all");
    setArrangement("all");
    setSource("all");
    setJob("all");
    setTrash(false);
    setBidder(result.bidder);
    setResume(result.resume);
    setDateMode("custom");
    setFrom(result.date);
    setTo(result.date);
    setFilters(true);
    refreshSnapshot();
    router.refresh();
  }
  const [status, setStatus] = useState("all");
  const [arrangement, setArrangement] = useState("all");
  const [resume, setResume] = useState("all");
  const [bidder, setBidder] = useState(bidderId ?? "all");
  const resumeChoices = useMemo(
    () => filterResumeOptions(assignments, "", bidderId ?? bidder),
    [assignments, bidderId, bidder],
  );
  function changeBidder(next: string) {
    setResume((current) => compatibleResume(assignments, current, next));
    setBidder(next);
  }
  const [source, setSource] = useState("all");
  const [job, setJob] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [filters, setFilters] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([
    { id: "found_at", desc: true },
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 });
  const [customPageSize, setCustomPageSize] = useState(false);
  const pageSize = pagination.pageSize;
  const [selected, setSelected] = useState<string>();
  const [history, setHistory] = useState<Omit<Row<"bid_events">, "details">[]>(
    [],
  );
  const [reason, setReason] = useState("");
  const [interviewEditor, setInterviewEditor] = useState<Bid | null>(null);
  const [interviewAt, setInterviewAt] = useState("");
  const [interviewNotes, setInterviewNotes] = useState("");
  const [interviewReason, setInterviewReason] = useState("");
  const [clearInterview, setClearInterview] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const [dateMode, setDateMode] = useState<CalendarPeriod>("today");
  const [trash, setTrash] = useState(false);
  const [today, setToday] = useState(() =>
    formatInTimeZone(new Date(), BID_TIMEZONE, "yyyy-MM-dd"),
  );
  const [list, setList] = useState(data.bids);
  const [totalCount, setTotalCount] = useState(0);
  const [sourceOptions, setSourceOptions] = useState<string[]>([]);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  const query = useMemo(
    () => ({
      search: debouncedSearch,
      status,
      arrangement,
      resume,
      bidder,
      source,
      job,
      columnFilters,
      sorting,
      pageIndex: pagination.pageIndex,
      pageSize,
    }),
    [
      debouncedSearch,
      status,
      arrangement,
      resume,
      bidder,
      source,
      job,
      columnFilters,
      sorting,
      pagination.pageIndex,
      pageSize,
    ],
  );
  const queryKey = bidReadKey(
    data,
    dateMode,
    from,
    to,
    trash,
    bidderId,
    query,
    today,
  );
  const [loadedKey, setLoadedKey] = useState<string>();
  const hasResults = loadedKey === queryKey;
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (editing.current) {
        deferredRefresh.current = true;
        return;
      }
      setDebouncedSearch(search);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (
      new URLSearchParams(window.location.search).get("review") === "pending"
    ) {
      setStatus("pending_review");
      setDateMode("all");
      setTrash(false);
    }
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      const now = new Date();
      const day = calendarToday(now);
      const next = fromZonedTime(
        `${shiftCalendarDate(day, 1)}T00:00:00`,
        BID_TIMEZONE,
      );
      timer = setTimeout(update, Math.max(1, next.getTime() - now.getTime()));
      if (editing.current) {
        deferredRefresh.current = true;
        return;
      }
      setToday(day);
    };
    const focus = () => {
      if (editing.current) {
        deferredRefresh.current = true;
        return;
      }
      update();
      setRevision((n) => n + 1);
    };
    update();
    window.addEventListener("focus", focus);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", focus);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (editing.current) {
        deferredRefresh.current = true;
        return;
      }
      setLoading(true);
      if (revision > 0 || initial?.key !== queryKey)
        seedEligible.current = false;
      const seed = seedEligible.current
        ? seedFor(queryKey, initial)
        : undefined;
      const ticket = seed
        ? null
        : requests.current.load(queryKey, () =>
            getBidRows(dateMode, from, to, trash, bidderId, query).catch(
              () => ({ error: "Could not refresh bids. Please retry." }),
            ),
          );
      const result = seed ?? (await ticket!.promise);
      if (cancelled || (ticket && !requests.current.current(ticket))) return;
      if (editing.current) {
        deferredRefresh.current = true;
        setLoading(false);
        return;
      }
      setLoading(false);
      if (result.error || !result.data) {
        setLoadError(
          result.error || "Bid results could not be loaded. Please retry.",
        );
      } else {
        setLoadError("");
        const page = result.data as
          | {
              rows: Bid[];
              total: number;
              sources: string[];
              statusCounts: Record<string, number>;
            }
          | undefined;
        setList(page?.rows ?? []);
        setTotalCount(page?.total ?? 0);
        setSourceOptions(page?.sources ?? []);
        setStatusCounts(page?.statusCounts ?? {});
        setLoadedKey(queryKey);
      }
    };
    if (preferencesReady) void run();
    return () => {
      cancelled = true;
    };
  }, [
    initial,
    preferencesReady,
    query,
    data,
    dateMode,
    from,
    to,
    trash,
    bidderId,
    today,
    revision,
    debouncedSearch,
    status,
    arrangement,
    resume,
    bidder,
    source,
    job,
    columnFilters,
    sorting,
    pagination.pageIndex,
    pageSize,
    queryKey,
  ]);
  useEffect(() => {
    const targets = Object.entries(checked).map(([id, target]) => ({
      id,
      version: target.version,
    }));
    if (!targets.length) return;
    let cancelled = false;
    void reconcileBidTargets(targets, trash)
      .catch(() => ({ data: undefined }))
      .then(({ data: ids }) => {
        if (cancelled || !ids) return;
        const eligible = new Set(ids);
        setChecked((current) => {
          const next = Object.fromEntries(
            Object.entries(current).filter(([id]) => eligible.has(id)),
          );
          return Object.keys(next).length === Object.keys(current).length
            ? current
            : next;
        });
      });
    return () => {
      cancelled = true;
    };
  }, [checked, trash]);
  useEffect(() => {
    const requestStore = requests.current;
    const historyGeneration = historyRequest;
    const clear = () => {
      requestStore.invalidate();
      historyGeneration.current++;
      setList([]);
      setTotalCount(0);
      setSourceOptions([]);
      setStatusCounts({});
      setChecked({});
      setSelected(undefined);
      setHistory([]);
      setLoadedKey(undefined);
    };
    window.addEventListener("workspace-access-revoked", clear);
    return () => {
      requestStore.invalidate();
      historyGeneration.current++;
      window.removeEventListener("workspace-access-revoked", clear);
    };
  }, []);
  const filteredRows = hasResults ? list : [];
  const active = filteredRows.find((b) => b.id === selected);
  const timezone = BID_TIMEZONE;
  function openBid(b: Bid) {
    setSelected(b.id);
    setReason("");
    setHistory([]);
    const generation = ++historyRequest.current;
    start(async () => {
      const result = await getBidHistory(b.id).catch(() => ({
        error: "Could not load bid history. Reopen this bid to retry.",
        data: undefined,
      }));
      if (generation !== historyRequest.current) return;
      if (result.error) toast.error(result.error);
      else setHistory(result.data ?? []);
    });
  }
  async function toggleTrash(b: Bid) {
    const result = await bidAction(() => trashBid(b.id, !b.deleted_at));
    if (result.error) toast.error(result.error);
    else {
      toast.success(b.deleted_at ? "Bid restored" : "Bid moved to trash");
      setSelected(undefined);
      refreshSnapshot();
      router.refresh();
    }
  }
  const ct = (stamp: string | null) =>
    stamp
      ? formatInTimeZone(stamp, BID_TIMEZONE, "MMM d, yyyy h:mm a") + " CT"
      : "-";
  function editInterview(bid: Bid, clearing = false) {
    setInterviewEditor(bid);
    setClearInterview(clearing);
    setInterviewAt(
      bid.interview_at
        ? formatInTimeZone(bid.interview_at, BID_TIMEZONE, "yyyy-MM-dd'T'HH:mm")
        : "",
    );
    setInterviewNotes(bid.interview_notes);
    setInterviewReason("");
  }
  function saveInterview() {
    if (!interviewEditor) return;
    if (clearInterview && !interviewReason.trim()) {
      toast.error("A correction reason is required");
      return;
    }
    start(async () => {
      const result = await bidAction(() =>
        setBidInterviewAction({
          bid: interviewEditor.id,
          scheduled: !clearInterview,
          localTime: clearInterview ? "" : interviewAt,
          notes: clearInterview ? "" : interviewNotes,
          reason: interviewReason,
        }),
      );
      if (result.error) toast.error(result.error);
      else {
        toast.success(
          clearInterview
            ? "Interview status corrected"
            : "Interview invitation saved",
        );
        setInterviewEditor(null);
        refreshSnapshot();
      }
    });
  }
  function headerControl(id: string, label: string, options?: string[]) {
    // The returned callback is TanStack's header renderer, not a React component.
    // eslint-disable-next-line react/display-name
    return ({
      column,
    }: {
      column: import("@tanstack/react-table").Column<Bid>;
    }) => (
      <div className="flex items-center gap-1">
        <button
          disabled={isEditing}
          onClick={() => column.toggleSorting()}
          className="flex items-center gap-1"
        >
          {label}
          <ArrowUpDown size={11} />
        </button>
        <div data-filter-column={id}>
          <PopoverPrimitive.Root
            open={openFilter === id}
            onOpenChange={(open) => setOpenFilter(open ? id : null)}
          >
            <PopoverPrimitive.Trigger asChild>
              <button
                type="button"
                aria-label={`Filter ${label}`}
                title={`Filter ${label}`}
                aria-expanded={openFilter === id}
                disabled={isEditing}
                className="rounded p-1 text-muted-foreground hover:bg-secondary"
              >
                <SlidersHorizontal size={12} />
              </button>
            </PopoverPrimitive.Trigger>
            <PopoverPrimitive.Portal>
              <PopoverPrimitive.Content
                sideOffset={4}
                align="start"
                collisionPadding={8}
                className="z-50 max-h-[min(24rem,calc(100dvh-1rem))] w-56 overflow-y-auto rounded-md border bg-card p-3 text-foreground shadow-lg"
              >
                {id === "screenshot" && canReview && (
                  <div className="mb-3 space-y-1 border-b pb-3">
                    {[
                      { label: "Size: smallest first", desc: false },
                      { label: "Size: largest first", desc: true },
                    ].map((order) => (
                      <button
                        key={order.label}
                        type="button"
                        disabled={isEditing}
                        aria-pressed={
                          sorting[0]?.id === "screenshot_size_bytes" &&
                          sorting[0]?.desc === order.desc
                        }
                        className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-secondary aria-pressed:bg-secondary aria-pressed:font-medium disabled:opacity-50"
                        onClick={() => {
                          setOpenFilter(null);
                          setSorting([
                            { id: "screenshot_size_bytes", desc: order.desc },
                          ]);
                        }}
                      >
                        {order.label}
                      </button>
                    ))}
                  </div>
                )}
                {id === "found_at" || id === "applied_at" ? (
                  (() => {
                    const range =
                      (column.getFilterValue() as
                        | {
                            preset?: CalendarPeriod;
                            from?: string;
                            to?: string;
                            presence?: string;
                          }
                        | undefined) ?? {};
                    return (
                      <div className="space-y-2">
                        <select
                          aria-label={`${label} presence`}
                          className="native-select"
                          value={range.presence ?? "all"}
                          onChange={(event) =>
                            column.setFilterValue({
                              ...range,
                              presence: event.target.value,
                            })
                          }
                        >
                          <option value="all">Any</option>
                          <option value="has">Has time</option>
                          <option value="empty">No time</option>
                        </select>
                        <PeriodSelector
                          label={`${label} period`}
                          value={{
                            preset:
                              range.preset ??
                              (range.from && range.to ? "custom" : "all"),
                            from: range.from,
                            to: range.to,
                          }}
                          onChange={(selection) =>
                            column.setFilterValue({
                              ...selection,
                              presence: range.presence,
                            })
                          }
                        />
                      </div>
                    );
                  })()
                ) : options ? (
                  <select
                    aria-label={`${label} filter`}
                    className="native-select"
                    value={String(column.getFilterValue() ?? "")}
                    onChange={(event) =>
                      column.setFilterValue(event.target.value || undefined)
                    }
                  >
                    <option value="">All</option>
                    {options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    aria-label={`${label} filter`}
                    placeholder={`Filter ${label.toLowerCase()}`}
                    value={String(column.getFilterValue() ?? "")}
                    onChange={(event) =>
                      column.setFilterValue(event.target.value || undefined)
                    }
                  />
                )}
                <div className="mt-2 flex justify-between">
                  <button
                    className="text-xs text-primary"
                    onClick={() => column.setFilterValue(undefined)}
                  >
                    Clear filter
                  </button>
                  <button
                    className="text-xs text-muted-foreground"
                    onClick={() => setOpenFilter(null)}
                  >
                    Close
                  </button>
                </div>
              </PopoverPrimitive.Content>
            </PopoverPrimitive.Portal>
          </PopoverPrimitive.Root>
        </div>
      </div>
    );
  }
  const columns: ColumnDef<Bid>[] = [
    {
      accessorKey: "found_at",
      filterFn: (row, _id, value) => {
        const range = value as
          { from?: string; to?: string; presence?: string } | undefined;
        const day = formatInTimeZone(
          row.original.found_at,
          BID_TIMEZONE,
          "yyyy-MM-dd",
        );
        return (
          (!range?.from || day >= range.from) &&
          (!range?.to || day <= range.to) &&
          range?.presence !== "empty"
        );
      },
      header: headerControl("found_at", "Added date (CT)"),
      cell: ({ row }) => (
        <span className="text-xs">{ct(row.original.found_at)}</span>
      ),
    },
    {
      accessorKey: "resume_id",
      filterFn: (row, _id, value) => {
        const resume = resumeById.get(row.original.resume_id);
        const profile = profileById.get(resume?.profile_id ?? "");
        return `${profile?.identifier ?? ""} ${profile?.candidate_name ?? ""} ${resume?.email ?? ""}`
          .toLowerCase()
          .includes(String(value).toLowerCase());
      },
      header: headerControl("resume_id", "Profile ID"),
      cell: ({ row }) => (
        <Badge variant="outline">
          {profileById.get(
            resumeById.get(row.original.resume_id)?.profile_id ?? "",
          )?.identifier ?? "-"}
        </Badge>
      ),
    },
    {
      accessorKey: "company",
      header: headerControl("company", "Company name"),
      cell: ({ row }) => (
        <span className="font-medium">{row.original.company}</span>
      ),
    },
    { accessorKey: "role_name", header: headerControl("role_name", "Role") },
    {
      accessorKey: "url",
      header: headerControl("url", "Link"),
      cell: ({ row }) => (
        <a
          className="text-primary underline"
          href={row.original.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open job at ${row.original.company}`}
        >
          Open job
        </a>
      ),
    },
    {
      accessorKey: "bidder_id",
      filterFn: (row, _id, value) => {
        const profile = data.profiles.find(
          (item) => item.id === row.original.bidder_id,
        );
        return `${profile?.display_name ?? ""} ${row.original.bidder_id}`
          .toLowerCase()
          .includes(String(value).toLowerCase());
      },
      header: headerControl("bidder_id", "Bidder ID"),
      cell: ({ row }) => (
        <button
          className="text-left text-xs"
          title={row.original.bidder_id}
          aria-label={`Copy bidder account ID ${row.original.bidder_id}`}
          onClick={() =>
            void navigator.clipboard.writeText(row.original.bidder_id).then(
              () => toast.success("Account ID copied"),
              () => toast.error("Could not copy account ID"),
            )
          }
        >
          {data.profiles.find((p) => p.id === row.original.bidder_id)
            ?.display_name ?? "Bidder"}
          <span className="block font-mono text-[10px] text-muted-foreground">
            {row.original.bidder_id.slice(0, 8)}... Copy ID
          </span>
        </button>
      ),
    },
    {
      accessorKey: "source",
      header: headerControl("source", "Job site", sourceOptions),
    },
    {
      accessorKey: "applied",
      filterFn: (row, _id, value) =>
        value === (row.original.applied ? "Applied" : "Unapplied"),
      header: headerControl("applied", "Applied status", [
        "Applied",
        "Unapplied",
      ]),
      cell: ({ row }) => <AppliedBadge applied={row.original.applied} />,
    },
    {
      accessorKey: "applied_at",
      filterFn: (row, _id, value) => {
        const range = value as
          { from?: string; to?: string; presence?: string } | undefined;
        if (!row.original.applied_at)
          return range?.presence === "empty" && !range.from && !range.to;
        const day = formatInTimeZone(
          row.original.applied_at,
          BID_TIMEZONE,
          "yyyy-MM-dd",
        );
        return (
          range?.presence !== "empty" &&
          (!range?.from || day >= range.from) &&
          (!range?.to || day <= range.to)
        );
      },
      header: headerControl("applied_at", "Applied time (CT)"),
      cell: ({ row }) => (
        <span className="text-xs">{ct(row.original.applied_at)}</span>
      ),
    },
    {
      accessorKey: "arrangement",
      header: headerControl("arrangement", "Work arrangement", [
        "remote",
        "onsite",
        "hybrid",
      ]),
      cell: ({ getValue }) => (
        <span className="capitalize">{String(getValue())}</span>
      ),
    },
    {
      accessorKey: "job_status",
      header: headerControl("job_status", "Job status", ["open", "closed"]),
    },
    {
      accessorKey: "review_status",
      header: headerControl("review_status", "Review status", [
        "pending",
        "approved",
        "rejected",
      ]),
      cell: ({ row }) => {
        const bid = row.original;
        const manager = data.profile.role !== "bidder";
        return (
          <div className="min-w-36 space-y-1">
            <Badge
              variant={
                bid.review_status === "approved" ? "secondary" : "outline"
              }
            >
              {bid.review_status.replaceAll("_", " ")}
            </Badge>
            {bid.review_status === "rejected" && bid.review_reason && (
              <p className="max-w-40 text-[10px] text-destructive">
                {bid.review_reason}
              </p>
            )}
            {!bid.deleted_at &&
              manager &&
              !bid.applied &&
              bid.review_status !== "approved" && (
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        const result = await bidAction(() =>
                          reviewBidAction(bid.id, "approved", "", bid.version),
                        );
                        if (result.error) toast.error(result.error);
                        else {
                          toast.success("Application approved");
                          refreshSnapshot();
                        }
                      })
                    }
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      const reason = window.prompt(
                        "Reason for rejection (required)",
                      );
                      if (!reason?.trim()) return;
                      start(async () => {
                        const result = await bidAction(() =>
                          reviewBidAction(
                            bid.id,
                            "rejected",
                            reason,
                            bid.version,
                          ),
                        );
                        if (result.error) toast.error(result.error);
                        else {
                          toast.success("Application returned for correction");
                          refreshSnapshot();
                        }
                      });
                    }}
                  >
                    Reject
                  </Button>
                </div>
              )}
            {!manager && bid.review_status === "rejected" && !bid.applied && (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const result = await bidAction(() =>
                      resubmitBidAction(bid.id, bid.version),
                    );
                    if (result.error) toast.error(result.error);
                    else {
                      toast.success("Resubmitted for review");
                      refreshSnapshot();
                    }
                  })
                }
              >
                Resubmit
              </Button>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "interview_scheduled",
      filterFn: (row, _id, value) =>
        value ===
        (row.original.interview_scheduled ? "Scheduled" : "Not scheduled"),
      header: headerControl("interview_scheduled", "Interview status", [
        "Scheduled",
        "Not scheduled",
      ]),
      cell: ({ row }) => {
        const bid = row.original;
        return (
          <div className="min-w-36 space-y-1">
            <Badge variant={bid.interview_scheduled ? "secondary" : "outline"}>
              {bid.interview_scheduled ? "Interview scheduled" : "—"}
            </Badge>
            {bid.interview_scheduled && (
              <p className="text-[10px] text-muted-foreground">
                {bid.interview_at ? ct(bid.interview_at) : "Date not set"}
              </p>
            )}
            {data.profile.role !== "bidder" &&
              bid.applied &&
              !bid.deleted_at && (
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => editInterview(bid)}
                  >
                    {bid.interview_scheduled ? "Edit" : "Record"}
                  </Button>
                  {bid.interview_scheduled && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => editInterview(bid, true)}
                    >
                      Clear
                    </Button>
                  )}
                </div>
              )}
          </div>
        );
      },
    },
    {
      id: "screenshot",
      accessorFn: (row) => Boolean(row.evidence_file_id),
      filterFn: (row, _id, value) =>
        value ===
        (row.original.evidence_file_id ? "Has screenshot" : "No screenshot"),
      sortingFn: (a, b) =>
        Number(Boolean(a.original.evidence_file_id)) -
        Number(Boolean(b.original.evidence_file_id)),
      header: headerControl("screenshot", "Screenshot", [
        "Has screenshot",
        "No screenshot",
        ...(canReview ? ["Repeated sizes only"] : []),
      ]),
      cell: ({ row }) => (
        <ScreenshotCell
          bid={row.original}
          role={data.profile.role}
          onUploaded={refreshSnapshot}
          disabled={
            isEditing || pending || row.original.review_status !== "approved"
          }
          onBusy={(value) => {
            setUploadBusy(value);
            editingChanged(value);
          }}
        />
      ),
    },
    ...(canReview
      ? ([
          {
            id: "applied_ip_location",
            header: "Applied IP / location",
            enableSorting: false,
            cell: ({ row }) => (
              <AppliedIpLocationCell
                key={row.original.evidence_file_id ?? "no-screenshot"}
                fileId={row.original.evidence_file_id}
                actorScope={actorReadScope(data)}
                role={data.profile.role}
                disabled={isEditing || pending}
              />
            ),
          },
        ] satisfies ColumnDef<Bid>[])
      : []),
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => (
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={pending || isEditing}
            onClick={() => start(() => toggleTrash(row.original))}
          >
            {row.original.deleted_at ? "Restore" : "Move to trash"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`View ${row.original.role_name} at ${row.original.company}`}
            onClick={() => openBid(row.original)}
          >
            History & details
          </Button>
        </div>
      ),
    },
  ];
  // TanStack Table owns memoization internally.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: filteredRows,
    getRowId: (row) => row.id,
    autoResetPageIndex: false,
    columns,
    state: { sorting, columnFilters, pagination },
    manualFiltering: true,
    manualSorting: true,
    manualPagination: true,
    pageCount: Math.ceil(totalCount / pageSize),
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
  });
  const filterKey = JSON.stringify([
    search,
    status,
    arrangement,
    resume,
    bidder,
    source,
    job,
    dateMode,
    from,
    to,
    trash,
    sorting,
    columnFilters,
    (dateMode !== "custom" && dateMode !== "all") ||
    columnFilters.some(
      (filter) =>
        filter.value &&
        typeof filter.value === "object" &&
        "preset" in filter.value &&
        filter.value.preset !== "custom" &&
        filter.value.preset !== "all",
    )
      ? today
      : "",
  ]);
  useEffect(() => {
    setChecked({});
    table.setPageIndex(0);
  }, [filterKey, table]);
  useEffect(() => {
    try {
      const saved = Number(
        localStorage.getItem(`bidder-check-page-size:${data.profile.id}`),
      );
      if (Number.isInteger(saved) && saved >= 1 && saved <= 100) {
        setPagination((current) => ({ ...current, pageSize: saved }));
        setCustomPageSize(![10, 25, 50, 100].includes(saved));
      }
    } catch {
      /* Browser storage is optional. */
    }
    setPreferencesReady(true);
  }, [data.profile.id]);
  useEffect(() => {
    if (!hasResults) return;
    const max = Math.max(0, Math.ceil(totalCount / pageSize) - 1);
    if (table.getState().pagination.pageIndex > max) table.setPageIndex(max);
  }, [totalCount, columnFilters, pageSize, table, hasResults]);
  return (
    <>
      {paste !== null && (
        <SheetsImport
          data={data}
          initialText={paste}
          bidderId={bidderId}
          fallbackFocusRef={importLauncher}
          onClose={() => setPaste(null)}
          onSuccess={imported}
        />
      )}
      {!embedded && (
        <PageHeading
          eyebrow="EVERY OPPORTUNITY, ACCOUNTED FOR"
          title="Your bid workspace."
          description="From the first find to the final click. Keep every application in view."
        >
          <Button
            ref={importLauncher}
            variant="outline"
            onClick={() => setPaste("")}
          >
            Paste from Sheets
          </Button>
          <BidDialog
            data={data}
            bidderId={bidderId ?? (bidder === "all" ? undefined : bidder)}
          />
        </PageHeading>
      )}
      <section className="panel overflow-hidden">
        <fieldset disabled={isEditing} className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
            <div className="flex flex-wrap gap-1">
              {[
                "all",
                "unapplied",
                "applied",
                ...(data.profile.role === "bidder" ? [] : ["pending_review"]),
              ].map((s) => (
                <Button
                  key={s}
                  variant={status === s ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={status === s}
                  onClick={() => {
                    setStatus(s);
                    if (s === "pending_review") setDateMode("all");
                  }}
                  className="text-xs capitalize"
                >
                  {s === "all"
                    ? "All bids"
                    : s === "pending_review"
                      ? "Pending review"
                      : s}
                  <span className="ml-1 rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {hasResults ? (statusCounts[s] ?? 0) : "—"}
                  </span>
                </Button>
              ))}
            </div>
            {embedded && (
              <div className="flex gap-2">
                <Button
                  ref={importLauncher}
                  variant="outline"
                  onClick={() => setPaste("")}
                >
                  Paste from Sheets
                </Button>
                <BidDialog
                  data={data}
                  bidderId={bidderId ?? (bidder === "all" ? undefined : bidder)}
                />
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
            <PeriodSelector
              key={`${dateMode}:${from}:${to}`}
              label="Found period"
              value={{ preset: dateMode, from, to }}
              onChange={(selection) => {
                setDateMode(selection.preset);
                setFrom(selection.from ?? "");
                setTo(selection.to ?? "");
              }}
            />
            <Button
              size="sm"
              className="ml-auto"
              variant={trash ? "secondary" : "outline"}
              aria-pressed={trash}
              onClick={() => setTrash(!trash)}
            >
              {trash ? "Back to active bids" : "Trash"}
            </Button>
          </div>
          {loadError && (
            <p role="alert" className="px-5 pt-3 text-sm text-destructive">
              {loadError}{" "}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRevision((n) => n + 1)}
              >
                Retry
              </Button>
            </p>
          )}
          <div className="flex gap-3 p-5">
            <div className="relative flex-1">
              <Search
                className="absolute left-3 top-2.5 text-muted-foreground"
                size={15}
              />
              <Input
                aria-label="Search bids"
                className="max-w-sm pl-9"
                placeholder="Search company, role, or URL…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFilters(!filters)}
              aria-expanded={filters}
            >
              <SlidersHorizontal size={14} /> Filters
            </Button>
          </div>
          {filters && (
            <div className="grid gap-3 border-b px-5 pb-5 sm:grid-cols-3 xl:grid-cols-4">
              <ResumeSelector
                options={resumeChoices}
                value={resume}
                onChange={setResume}
                disabled={isEditing}
              />
              {data.profile.role !== "bidder" && !bidderId && (
                <SelectField
                  label="Bidder"
                  value={bidder}
                  onChange={(e) => changeBidder(e.target.value)}
                >
                  <option value="all">All bidders</option>
                  {data.bidders.map((b) => (
                    <option key={b.user_id} value={b.user_id}>
                      {
                        data.profiles.find((p) => p.id === b.user_id)
                          ?.display_name
                      }
                    </option>
                  ))}
                </SelectField>
              )}
              <SelectField
                label="Work arrangement"
                value={arrangement}
                onChange={(e) => setArrangement(e.target.value)}
              >
                <option value="all">All arrangements</option>
                {["remote", "onsite", "hybrid"].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label="Job status"
                value={job}
                onChange={(e) => setJob(e.target.value)}
              >
                <option value="all">All jobs</option>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </SelectField>
              <SelectField
                label="Jobsite source"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="all">All sources</option>
                {sourceOptions.filter(Boolean).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </SelectField>
              <Button
                variant="ghost"
                className="self-end"
                onClick={() => {
                  setResume("all");
                  setBidder(bidderId ?? "all");
                  setArrangement("all");
                  setJob("all");
                  setSource("all");
                  setDateMode("today");
                  setFrom("");
                  setTo("");
                  setSearch("");
                }}
              >
                Clear filters
              </Button>
            </div>
          )}
        </fieldset>
        <BulkBidToolbar
          targets={Object.entries(checked).map(([id, target]) => ({
            id,
            version: target.version,
            applied: target.applied,
          }))}
          trash={trash}
          manager={data.profile.role !== "bidder"}
          bidderId={bidderId}
          disabled={isEditing || pending}
          loading={loading}
          clear={() => setChecked({})}
          onBusy={(value) => {
            setBulkBusy(value);
            editingChanged(value);
          }}
          onDone={() => {
            setChecked({});
            setSelected(undefined);
            refreshSnapshot();
            router.refresh();
          }}
        />
        <BidGrid
          checked={checked}
          disabled={pending || bulkBusy || uploadBusy}
          onCheck={(rows, value) =>
            setChecked((current) => {
              const next = { ...current };
              rows.forEach((row) => {
                if (value)
                  next[row.id] = { version: row.version, applied: row.applied };
                else delete next[row.id];
              });
              if (Object.keys(next).length > 500) {
                toast.error("Select at most 500 bids per operation");
                return current;
              }
              return next;
            })
          }
          table={table}
          data={data}
          onRow={(row) => {
            setList((current) =>
              current.map((b) => (b.id === row.id ? { ...b, ...row } : b)),
            );
            refreshSnapshot();
          }}
          onBusy={editingChanged}
          onPaste={setPaste}
          onOpen={openBid}
          emptyMessage={
            loading
              ? <PageLoading label="Loading bid applications…" size="section" />
              : loadError
                ? "Bid results could not be loaded. Use Retry above to try again."
                : canReview &&
                    columnFilters.some(
                      (filter) =>
                        filter.id === "screenshot" &&
                        filter.value === "Repeated sizes only",
                    )
                  ? "No applications with matching screenshot sizes"
                  : totalCount > 0
                    ? "No matching opportunities. Clear filters or change your search to see bids."
                    : "Your next opportunity starts here. Add a job URL and choose a resume to start tracking."
          }
        />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4 text-xs text-muted-foreground">
          <span>
            {hasResults ? (
              <>
                {totalCount === 0
                  ? 0
                  : table.getState().pagination.pageIndex * pageSize + 1}
                –
                {Math.min(
                  (table.getState().pagination.pageIndex + 1) * pageSize,
                  totalCount,
                )}{" "}
                of {totalCount} bids
              </>
            ) : loading ? (
              "Loading results…"
            ) : (
              "Results unavailable"
            )}
          </span>
          <div className="flex max-w-full flex-wrap items-center gap-3">
            <label className="flex max-w-full flex-wrap items-center gap-2">
              Rows per page{" "}
              <select
                aria-label="Rows per page"
                disabled={isEditing}
                className="native-select min-w-24 max-w-24 shrink-0"
                value={customPageSize ? "custom" : pageSize}
                onChange={(event) => {
                  if (event.target.value === "custom") {
                    setCustomPageSize(true);
                    return;
                  }
                  setCustomPageSize(false);
                  const value = Number(event.target.value);
                  setPagination({ pageIndex: 0, pageSize: value });
                  try {
                    localStorage.setItem(
                      `bidder-check-page-size:${data.profile.id}`,
                      String(value),
                    );
                  } catch {}
                }}
              >
                {[10, 25, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
              {customPageSize && (
                <input
                  aria-label="Custom rows per page"
                  disabled={isEditing}
                  type="number"
                  min={1}
                  max={100}
                  value={pageSize}
                  className="h-9 w-16 shrink-0 rounded-md border bg-background px-2"
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isInteger(value) && value >= 1 && value <= 100) {
                      setPagination({ pageIndex: 0, pageSize: value });
                      try {
                        localStorage.setItem(
                          `bidder-check-page-size:${data.profile.id}`,
                          String(value),
                        );
                      } catch {}
                    }
                  }}
                />
              )}
            </label>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                aria-label="Previous page"
                size="icon-sm"
                variant="outline"
                disabled={
                  isEditing || !hasResults || !table.getCanPreviousPage()
                }
                onClick={() => table.previousPage()}
              >
                <ChevronLeft size={14} />
              </Button>
              <span className="px-2">
                {table.getState().pagination.pageIndex + 1}
              </span>
              <Button
                aria-label="Next page"
                size="icon-sm"
                variant="outline"
                disabled={isEditing || !hasResults || !table.getCanNextPage()}
                onClick={() => table.nextPage()}
              >
                <ChevronRight size={14} />
              </Button>
            </div>
          </div>
        </div>
      </section>
      <Dialog
        open={!!interviewEditor}
        onOpenChange={(open) => {
          if (!open) setInterviewEditor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {clearInterview
                ? "Correct interview status"
                : interviewEditor?.interview_scheduled
                  ? "Edit interview invitation"
                  : "Record interview invitation"}
            </DialogTitle>
            <DialogDescription>
              {interviewEditor?.company} · {interviewEditor?.role_name}.
              Interview details are visible only within this workspace and the
              assigned bidder.
            </DialogDescription>
          </DialogHeader>
          {!clearInterview && (
            <>
              <Field
                label="Interview date and time (CT)"
                type="datetime-local"
                value={interviewAt}
                onChange={(event) => setInterviewAt(event.target.value)}
              />
              <label className="block space-y-2 text-xs">
                Notes
                <Textarea
                  rows={4}
                  maxLength={2000}
                  value={interviewNotes}
                  onChange={(event) => setInterviewNotes(event.target.value)}
                  placeholder="Optional details for the interview."
                />
              </label>
            </>
          )}
          {clearInterview && (
            <label className="block space-y-2 text-xs">
              Correction reason
              <Textarea
                rows={3}
                maxLength={1000}
                value={interviewReason}
                onChange={(event) => setInterviewReason(event.target.value)}
                required
                placeholder="Explain why this interview status is being cleared."
              />
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setInterviewEditor(null)}>
              Cancel
            </Button>
            <Button
              variant={clearInterview ? "destructive" : "default"}
              disabled={pending || (clearInterview && !interviewReason.trim())}
              onClick={saveInterview}
            >
              {clearInterview ? "Clear status" : "Save interview"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Sheet
        open={!!active}
        onOpenChange={(open) => {
          if (!open) {
            historyRequest.current++;
            setSelected(undefined);
          }
        }}
      >
        <SheetContent className="w-full overflow-y-auto p-6 sm:max-w-lg">
          {active && (
            <>
              <SheetHeader className="p-0">
                <span className="mb-3 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <BriefcaseBusiness size={24} />
                </span>
                <SheetTitle className="text-xl">{active.role_name}</SheetTitle>
                <SheetDescription>
                  {active.company} · {active.arrangement}
                </SheetDescription>
              </SheetHeader>
              <div className="mt-6 space-y-6">
                <div className="flex items-center justify-between">
                  <AppliedBadge applied={active.applied} />
                  {!active.deleted_at && <BidDialog data={data} bid={active} />}
                </div>
                <a
                  href={active.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm font-medium text-primary"
                >
                  Open job listing <ArrowUpRight size={14} />
                </a>
                <div className="grid grid-cols-2 gap-5 rounded-xl bg-background p-4">
                  {[
                    {
                      label: "Resume",
                      value: data.resumes.find((r) => r.id === active.resume_id)
                        ?.profile_id
                        ? data.candidateProfiles.find(
                            (p) =>
                              p.id ===
                              data.resumes.find(
                                (r) => r.id === active.resume_id,
                              )?.profile_id,
                          )?.identifier
                        : undefined,
                    },
                    { label: "Source", value: active.source },
                    { label: "Job status", value: active.job_status },
                    ...(data.profile.role !== "bidder"
                      ? [
                          {
                            label: "Saved rate",
                            value:
                              active.rate_cents == null
                                ? "Set on application"
                                : usd(active.rate_cents),
                          },
                        ]
                      : []),
                    {
                      label: "Found",
                      value: formatInTimeZone(
                        active.found_at,
                        timezone,
                        "MMM d, h:mm a",
                      ),
                    },
                    {
                      label: "Applied",
                      value: active.applied_at
                        ? formatInTimeZone(
                            active.applied_at,
                            timezone,
                            "MMM d, h:mm a",
                          )
                        : "Not yet",
                    },
                  ].map((x) => (
                    <div key={x.label}>
                      <p className="eyebrow mb-1.5">{x.label}</p>
                      <p className="text-xs capitalize">{x.value || "—"}</p>
                    </div>
                  ))}
                </div>
                {active.evidence_file_id && (
                  <FileButton
                    id={active.evidence_file_id}
                    label="View application screenshot"
                  />
                )}
                {!active.deleted_at && (
                  <div className="space-y-4 border-t pt-5">
                    <h3 className="text-sm font-semibold">
                      {active.applied
                        ? "Replace screenshot"
                        : active.evidence_file_id
                          ? "Upload new proof"
                          : "Application proof"}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {active.review_status === "approved"
                        ? "Upload automatically records the application"
                        : active.review_status === "pending"
                          ? "Waiting for client review before proof upload."
                          : "Correct this bid and resubmit it for review before uploading proof."}
                    </p>
                    <FileUpload
                      kind="screenshot"
                      target={active.id}
                      disabled={active.review_status !== "approved"}
                      onUploaded={() => {
                        setSelected(undefined);
                        refreshSnapshot();
                        router.refresh();
                      }}
                    />
                  </div>
                )}
                {active.applied &&
                  !active.deleted_at &&
                  data.profile.role !== "bidder" && (
                    <div className="space-y-3 border-t pt-5">
                      <h3 className="text-sm font-semibold">
                        Correct application status
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        This removes earnings until new proof is submitted.
                      </p>
                      <Textarea
                        aria-label="Correction reason"
                        placeholder="Reason for correction"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                      <Button
                        variant="outline"
                        disabled={pending || !reason.trim()}
                        onClick={() =>
                          start(async () => {
                            const result = await bidAction(() =>
                              unapplyBid(active.id, reason),
                            );
                            if (result.error) toast.error(result.error);
                            else {
                              toast.success("Marked unapplied");
                              setSelected(undefined);
                              refreshSnapshot();
                              router.refresh();
                            }
                          })
                        }
                      >
                        <RotateCcw size={14} /> Mark unapplied
                      </Button>
                    </div>
                  )}
                {canReview && (
                  <UploadHistory
                    key={`${data.profile.id}:${active.id}`}
                    bidId={active.id}
                    role={data.profile.role}
                  />
                )}
                <div className="border-t pt-5">
                  <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold">
                    <Clock size={15} /> Activity history
                  </h3>
                  {!history.length ? (
                    <p className="text-xs text-muted-foreground">
                      No application changes yet.
                    </p>
                  ) : (
                    <div className="space-y-4">
                      {history.map((e) => (
                        <div
                          key={e.id}
                          className="border-l-2 border-primary/20 pl-3"
                        >
                          <p className="text-xs font-medium capitalize">
                            Marked {e.event}
                          </p>
                          {e.reason && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {e.reason}
                            </p>
                          )}
                          <p className="mt-1 text-[10px] text-muted-foreground">
                            {formatInTimeZone(
                              e.created_at,
                              timezone,
                              "MMM d, yyyy · h:mm a",
                            )}
                          </p>
                          {e.file_id && (
                            <div className="mt-2">
                              <FileButton id={e.file_id} label="Evidence" />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
