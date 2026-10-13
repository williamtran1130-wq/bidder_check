// Isolated component fixture server. No production authentication bypass.
const unavailable = async () => ({
  error: "Mutations are disabled in the visual test fixture.",
});
export const authenticate = unavailable,
  signOut = unavailable,
  saveResume = unavailable,
  archiveResume = unavailable,
  saveCandidateProfile = unavailable,
  saveCandidateProfileRules = unavailable,
  previewCandidateRetention = unavailable,
  archiveCandidateProfile = unavailable,
  archiveResumeAssignment = unavailable,
  updateBidder = unavailable,
  updateClient = unavailable,
  createBidder = unavailable,
  reviewClient = unavailable,
  resetManagedPassword = unavailable,
  createClientAccount = unavailable,
  unapplyBid = unavailable,
  reviewBidAction = unavailable,
  reviewBidsAction = unavailable,
  resubmitBidAction = unavailable,
  setBidInterviewAction = unavailable,
  saveSettings = unavailable;
export async function getFileUrl() {
  if (new URLSearchParams(location.search).has("screenshot-sizes"))
    return { data: { url: "https://images.example.test/proof.png" } };
  return unavailable();
}
export async function saveBid() {
  if (new URLSearchParams(window.location.search).has("single-blocked"))
    return { data: { status: "blocked" as const } };
  return unavailable();
}
export async function manualApplyBidsAction(input: { targets: { id: string; version: number }[] }) {
  if (!new URLSearchParams(window.location.search).has("manual-apply")) return unavailable();
  window.dispatchEvent(new CustomEvent("manual-apply", { detail: input.targets.length }));
  return { data: { applied: input.targets.length, unchanged: 0 } };
}
export async function getEarningsPerformance(input: import("@/lib/report-types").GroupedReportQuery) {
  document.documentElement.dataset.earningsQuery = JSON.stringify(input);
  return { data: {
    totals: { count: 1, cents: 1000, resumes: 1, retainedCount: 0, trackedApplications: 1, trackedInterviews: 0, excludedInterviewCount: 0 },
    groups: [{ id: "resume-1", label: "ENG-01", sub: "Jamie Parker", count: 1, cents: 1000, applied: 1, interviews: 0 }],
  } };
}
export async function getInterviewPerformance(input: import("@/lib/report-types").GroupedReportQuery) {
  document.documentElement.dataset.interviewQuery = JSON.stringify(input);
  return { data: { totals: { applied: 1, interviews: 0, excludedApplications: 0 }, groups: [{ id: "profile-0", label: "ENG-01", applied: 1, interviews: 0, conversion: 0 }] } };
}
export async function getUnreadNotificationCount() { return { data: 0 }; }
export async function saveResumeAssignment(input: { id?: string; profileId: string; bidderId: string; email: string; phone: string; rate: string }) {
  if (!new URLSearchParams(location.search).has("assignment-upload")) return unavailable();
  window.dispatchEvent(new CustomEvent("assignment-save", { detail: input }));
  return { data: input.id || crypto.randomUUID() };
}
let preparedScreenshot: { target: string; bytes: number } | undefined;
export async function prepareUpload(_kind: string, target: string, _name?: string, _mime?: string, bytes?: number) {
  if (new URLSearchParams(location.search).has("screenshot-sizes")) {
    preparedScreenshot = { target, bytes: bytes! };
    return { data: { id: "fixture-screenshot-upload", storage_path: "fixture/screenshot.png" } };
  }
  if (new URLSearchParams(location.search).has("assignment-upload"))
    return { data: { id: target, storage_path: "fixture/resume.pdf" } };
  if (new URLSearchParams(location.search).has("paste-screenshot")) {
    document.documentElement.dataset.screenshotPrepared = target;
    window.dispatchEvent(new CustomEvent("screenshot-prepare", { detail: target }));
    return { data: { id: "fixture-screenshot-upload", storage_path: "fixture/screenshot.png" } };
  }
  return unavailable();
}
export async function finalizeUpload(id: string) {
  if (new URLSearchParams(location.search).has("screenshot-sizes") && preparedScreenshot) {
    const { fixture } = await import("./sample-data");
    const { target, bytes } = preparedScreenshot;
    fixture.bids = fixture.bids.map((bid) => bid.id === target ? { ...bid, evidence_file_id: id, screenshot_size_bytes: bytes, applied: true, version: bid.version + 1 } : bid);
    preparedScreenshot = undefined;
    return { data: id };
  }
  if (!new URLSearchParams(location.search).has("assignment-upload") && !new URLSearchParams(location.search).has("paste-screenshot")) return unavailable();
  if (new URLSearchParams(location.search).has("paste-screenshot")) document.documentElement.dataset.screenshotFinalized = id;
  return { data: id };
}
export const getBidHistory = async () => ({ data: [] });

let reads = 0;
export async function getBidRows(
  mode: string,
  from: string,
  to: string,
  trash: boolean,
  bidderId: string | undefined,
  query: import("@/lib/bid-list").BidListQuery,
) {
  if (
    new URLSearchParams(window.location.search).has("refresh-failure") &&
    reads++ > 0
  )
    return { error: "Refresh unavailable" };
  const { fixture } = await import("./sample-data");
  document.documentElement.dataset.bidListReads = String(Number(document.documentElement.dataset.bidListReads ?? 0) + 1);
  const { chicagoDateRange } = await import("@/lib/domain");
  const { calendarToday, resolveCalendarPeriod } = await import("@/lib/calendar-period");
  try {
    const bounds = chicagoDateRange(mode, from, to);
    const manager = (fixture.profile.role === "client" || fixture.profile.role === "admin") && fixture.profile.approval_status === "approved" && !fixture.profile.archived;
    const repeated = manager && query.columnFilters.some((filter) => filter.id === "screenshot" && filter.value === "Repeated sizes only");
    const matchesStatus = (b: import("@/lib/workspace-types").BidRow, status: string) => status === "all" || (status === "pending_review" ? b.review_status === "pending" : b.applied === (status === "applied"));
    const base = fixture.bids.filter((b) => {
      const columns = Object.fromEntries(query.columnFilters.map((filter) => [filter.id, filter.value]));
      return Boolean(b.deleted_at) === trash &&
        (fixture.profile.role !== "bidder" || b.bidder_id === fixture.profile.id) &&
        (!bidderId || b.bidder_id === bidderId) &&
        (!bounds.from || b.found_at >= bounds.from) && (!bounds.to || b.found_at < bounds.to) &&
        (query.bidder === "all" || b.bidder_id === query.bidder) &&
        (query.resume === "all" || b.resume_id === query.resume) &&
        (query.source === "all" || b.source === query.source) &&
        (query.arrangement === "all" || b.arrangement === query.arrangement) &&
        (query.job === "all" || b.job_status === query.job) &&
        `${b.company} ${b.role_name} ${b.url}`.toLowerCase().includes(query.search.toLowerCase()) &&
        Object.entries(columns).every(([field, value]) => {
          if (value && typeof value === "object") {
            const date = field === "applied_at" ? b.applied_at : b.found_at;
            if (!date) return (value as { presence?: string }).presence === "empty";
            const day = calendarToday(new Date(date));
            const column = value as { preset?: import("@/lib/calendar-period").CalendarPeriod; from?: string; to?: string; presence?: string };
            const range = column.preset ? resolveCalendarPeriod({ ...column, preset: column.preset }) : column;
            return column.presence !== "empty" && (!range.from || day >= range.from) && (!range.to || day <= range.to);
          }
          if (!value) return true;
          if (field === "screenshot" && value === "Repeated sizes only") return true;
          if (field === "resume_id") {
            const assignment = fixture.resumes.find((resume) => resume.id === b.resume_id);
            const profile = fixture.candidateProfiles.find((profile) => profile.id === assignment?.profile_id);
            return `${profile?.identifier ?? ""} ${profile?.candidate_name ?? ""} ${assignment?.email ?? ""}`.toLowerCase().includes(String(value).toLowerCase());
          }
          const actual = field === "applied" ? (b.applied ? "Applied" : "Unapplied") : field === "screenshot" ? (b.evidence_file_id ? "Has screenshot" : "No screenshot") : String(b[field as keyof typeof b] ?? "");
          return actual.toLowerCase().includes(String(value).toLowerCase());
        });
    });
    const sizeScenario = new URLSearchParams(location.search).has("screenshot-sizes");
    const statusCounts: Record<string, number> = {};
    let sizes = new Map<number, number>();
    let filtered = base;
    for (const status of ["all", "applied", "unapplied", "pending_review"]) {
      let rows = base.filter((bid) => matchesStatus(bid, status));
      const counts = new Map<number, number>();
      if (manager && sizeScenario) for (const bid of rows) {
        if (bid.evidence_file_id && bid.screenshot_size_bytes != null)
          counts.set(bid.screenshot_size_bytes, (counts.get(bid.screenshot_size_bytes) ?? 0) + 1);
      }
      if (repeated) rows = rows.filter((bid) => bid.evidence_file_id && bid.screenshot_size_bytes != null && (counts.get(bid.screenshot_size_bytes) ?? 0) >= 2);
      statusCounts[status] = rows.length;
      if (status === query.status) { filtered = rows; sizes = counts; }
    }
    const snapshot = filtered.map((bid) => manager && sizeScenario ? {
      ...bid,
      screenshot_size_bytes: bid.evidence_file_id ? bid.screenshot_size_bytes ?? null : null,
      screenshot_size_match_count: bid.evidence_file_id && bid.screenshot_size_bytes != null ? sizes.get(bid.screenshot_size_bytes) ?? 0 : 0,
    } : (() => { const safe = { ...bid }; delete safe.screenshot_size_bytes; delete safe.screenshot_size_match_count; return safe; })());
    const sorted = [...snapshot].sort((a, b) => {
      const sort = query.sorting[0];
      if (sort?.id === "screenshot_size_bytes" && manager) {
        const av = a.screenshot_size_bytes, bv = b.screenshot_size_bytes;
        if (av == null && bv != null) return 1;
        if (bv == null && av != null) return -1;
        const result = av != null && bv != null ? av - bv : 0;
        return (sort.desc ? -result : result) || b.found_at.localeCompare(a.found_at) || a.id.localeCompare(b.id);
      }
      if (!sort || sort.id === "screenshot_size_bytes" && !manager) return b.found_at.localeCompare(a.found_at) || a.id.localeCompare(b.id);
      if (sort.id === "screenshot") {
        const result = Number(Boolean(a.evidence_file_id)) - Number(Boolean(b.evidence_file_id));
        return (sort.desc ? -result : result) || b.found_at.localeCompare(a.found_at) || a.id.localeCompare(b.id);
      }
      const result = String(a[sort.id as keyof typeof a] ?? "").localeCompare(String(b[sort.id as keyof typeof b] ?? ""));
      return sort.desc ? -result : result;
    });
    return {
      data: { rows: sorted.slice(query.pageIndex * query.pageSize, (query.pageIndex + 1) * query.pageSize), total: sorted.length, sources: [...new Set(fixture.bids.map((b) => b.source).filter(Boolean))], statusCounts },
    };
  } catch (e) {
    return { error: String(e) };
  }
}

// Only this isolated Vite fixture simulates writes. Production actions always use RLS/RPCs.
export async function updateBidCell(
  id: string,
  field: string,
  value: string,
  version: number,
) {
  const { fixture } = await import("./sample-data");
  const row = fixture.bids.find((b) => b.id === id)!;
  if (row.version !== version) return { data: { conflict: true, row } };
  if (["company", "role_name"].includes(field) && !value.trim())
    return { error: "Required; maximum 200 characters" };
  const updated = { ...row, [field]: value, version: version + 1 };
  fixture.bids = fixture.bids.map((b) => (b.id === id ? updated : b));
  const safe = { ...updated };
  // Inline RPCs return stored columns, not the derived list snapshot metadata.
  delete safe.screenshot_size_bytes; delete safe.screenshot_size_match_count;
  return { data: { ok: true, row: safe } };
}
export async function checkBidImport(
  _resume: string,
  _date: string,
  rows: import("@/lib/sheets").ImportRow[],
) {
  if (new URLSearchParams(window.location.search).has("becomes-eligible")) {
    const count = Number(sessionStorage.getItem("eligibility-validation") ?? "0") + 1;
    sessionStorage.setItem("eligibility-validation", String(count));
    return { data: count === 1 ? rows.map((_, index) => ({row:index + 1,field:"company",code:"restricted_company",message:"Restricted company details"})) : [] };
  }
  if (new URLSearchParams(window.location.search).has("fresh-conflict")) {
    const count = Number(sessionStorage.getItem("fresh-import-validation") ?? "0") + 1;
    sessionStorage.setItem("fresh-import-validation", String(count));
    if (count >= 2) return { data: [{ row: 2, field: "url", code: "duplicate_url", message: "This profile already has an application for this job." }] };
  }
  if (new URLSearchParams(window.location.search).has("block-import")) {
    return {
      data: rows.map((_, index) => ({
        row: index + 1,
        field: "url",
        code: "profile_restriction",
        message: "This job URL is blocked by a profile restriction.",
      })),
    };
  }
  const { validateImportRows } = await import("@/lib/sheets");
  return { data: validateImportRows(rows) };
}
export async function importBids() {
  if (new URLSearchParams(location.search).has("lost-import")) return { error: "fetch failed", uncertain: true };
  return unavailable();
}
export async function reconcileBidTargets(targets: { id: string; version: number }[], trash: boolean) {
  const { fixture } = await import("./sample-data");
  return { data: targets.filter((target) => fixture.bids.some((row) => row.id === target.id && Boolean(row.deleted_at) === trash)).map((target) => target.id) };
}
export async function importReviewedBids(_resume: string, date: string, rows: import("@/lib/sheets").ImportRow[], sourceRows: number[], requestId: string) {
  const payload = JSON.stringify({resume:_resume,date,rows,sourceRows,requestId});
  const attempts: string[] = JSON.parse(sessionStorage.getItem("import-attempts") ?? "[]");
  attempts.push(payload);
  sessionStorage.setItem("import-attempts", JSON.stringify(attempts));
  if (new URLSearchParams(location.search).has("lost-import")) return { error: "fetch failed", uncertain: true };
  document.documentElement.dataset.lastImportCount = String(rows.length);
  return { data: { ids: rows.map(() => crypto.randomUUID()), sourceRows, skipped: [], date, bidder: "bidder-0", resume: "resume-0" } };
}

let reportReads = 0;
export async function getDashboardPerformance(input: import("@/lib/report-types").ReportQuery): Promise<import("@/lib/report-types").ReportResult<import("@/lib/report-types").DashboardReport>> {
  const { fixture } = await import("./sample-data");
  const { resolveCalendarPeriod, calendarToday, shiftCalendarDate, periodTimestampBounds } = await import("@/lib/calendar-period");
  const parameters = new URLSearchParams(window.location.search);
  reportReads++;
  document.documentElement.dataset.reportReads = String(reportReads);
  if (parameters.has("report-failure") && reportReads > 1)
    return { error: "This report is temporarily unavailable. Please retry.", code: "temporarily_unavailable" };
  if (parameters.has("report-delay")) await new Promise((resolve) => setTimeout(resolve, input.period.preset === "this_week" ? 500 : 20));
  document.documentElement.dataset.reportCompleted = input.period.preset;
  const range = resolveCalendarPeriod(input.period);
  const from = range.from ?? fixture.bids.map((row) => row.found_at.slice(0, 10)).sort()[0] ?? calendarToday();
  const to = range.to ?? calendarToday();
  const bounds = periodTimestampBounds({ from, to });
  const found = fixture.bids.filter((row) => !row.deleted_at && (!bounds.from || row.found_at >= bounds.from) && (!bounds.to || row.found_at < bounds.to));
  const days: import("@/lib/report-types").DashboardReport["series"] = [];
  for (let date = from; date <= to && days.length < 120; date = shiftCalendarDate(date, 1)) {
    const dailyBounds = periodTimestampBounds({ from: date, to: date });
    const rows = found.filter((row) => row.found_at >= dailyBounds.from! && row.found_at < dailyBounds.to!);
    days.push({ from: date, to: date, found: rows.length, foundApplied: rows.filter((row) => row.applied).length, applied: rows.filter((row) => row.applied).length });
  }
  const groupRows = (kind: "bidder" | "profile") => {
    const groups = new Map<string, import("@/lib/report-types").ComparisonRow>();
    for (const row of found) {
      const assignment = fixture.resumes.find((resume) => resume.id === row.resume_id);
      const key = kind === "bidder" ? row.bidder_id : assignment?.profile_id ?? "unknown";
      const label = kind === "bidder" ? fixture.profiles.find((person) => person.id === key)?.display_name : fixture.candidateProfiles.find((profile) => profile.id === key)?.identifier;
      const group = groups.get(key) ?? { id: key, label: label ?? key, found: 0, foundApplied: 0, arrangements: { remote: { found: 0, foundApplied: 0 }, onsiteHybrid: { found: 0, foundApplied: 0 }, unspecified: { found: 0, foundApplied: 0 } } };
      group.found++; if (row.applied) group.foundApplied++;
      const arrangement = row.arrangement === "remote" ? "remote" : "onsiteHybrid";
      group.arrangements![arrangement].found++;
      if (row.applied) group.arrangements![arrangement].foundApplied++;
      groups.set(key, group);
    }
    return [...groups.values()];
  };
  const scenario = parameters.get("arrangements");
  if (scenario) {
    const { comparisonFixtures } = await import("./sample-data");
    const rows = comparisonFixtures(scenario);
    const ownRows = fixture.profile.role === "bidder" ? rows.slice(0, 1) : rows;
    const totals = ownRows.reduce((sum, row) => ({ found: sum.found + row.found, foundApplied: sum.foundApplied + row.foundApplied }), { found: 0, foundApplied: 0 });
    return { data: {
      range: { from, to, bucketUnit: "day", bucketSize: 1 },
      series: [{ from, to, ...totals, applied: totals.foundApplied }],
      totals: { ...totals, appliedActivity: totals.foundApplied, trackedApplications: totals.foundApplied, trackedInterviews: 0 },
      comparisons: { bidders: fixture.profile.role === "bidder" ? [] : rows, profiles: ownRows },
      ...(fixture.profile.role !== "bidder" ? { financial: { earningsCents: 1000, earningsCount: 1 } } : {}),
    } };
  }
  return { data: {
    range: { from, to, bucketUnit: "day", bucketSize: 1 },
    series: days,
    totals: { found: found.length, foundApplied: found.filter((row) => row.applied).length, appliedActivity: found.filter((row) => row.applied).length, trackedApplications: 1, trackedInterviews: 0 },
    comparisons: { bidders: groupRows("bidder"), profiles: groupRows("profile") },
    ...(fixture.profile.role !== "bidder" ? { financial: { earningsCents: 1000, earningsCount: 1 } } : {}),
  } };
}

export async function trashBid(id: string, deleted: boolean) {
  const { fixture } = await import("./sample-data");
  fixture.bids = fixture.bids.map((b) =>
    b.id === id
      ? { ...b, deleted_at: deleted ? new Date().toISOString() : null }
      : b,
  );
  return { data: undefined };
}

export async function bulkBidState(
  targets: { id: string; version: number }[],
  deleted: boolean,
) {
  const { fixture } = await import("./sample-data");
  const ids = new Set(targets.map((t) => t.id));
  fixture.bids = fixture.bids.map((b) =>
    ids.has(b.id)
      ? {
          ...b,
          deleted_at: deleted ? new Date().toISOString() : null,
          version: b.version + 1,
        }
      : b,
  );
  return { data: targets.length };
}
export async function prepareBidPurge(
  mode: string,
  targets: { id: string; version: number }[],
) {
  const { fixture } = await import("./sample-data");
  return {
    data: {
      id: "fixture-operation",
      count:
        mode === "all"
          ? fixture.bids.filter((b) => b.deleted_at).length
          : targets.length,
      scope: "Selected trashed bids",
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    },
  };
}
export const confirmBidPurge = unavailable,
  getPurgeStatus = unavailable;
export const getInboxNotifications = async () => ({ data: [] });
export const getClientMessages = async () => ({ data: [] });
export const markInboxNotificationAction = unavailable,
  saveClientMessageAction = unavailable,
  setClientMessageStatusAction = unavailable,
  savePushSubscriptionAction = unavailable,
  deletePushSubscriptionAction = unavailable;
// `?purge-notice` simulates a removed screenshot whose verification becomes due in 4 seconds.
const loadedAt = Date.now();
let verified = false;
const purgeFixture = () => ({
  id: "fixture-operation",
  scope: "Selected trashed bids",
  deletedCount: 15,
  pendingFiles: verified ? 0 : 1,
  awaitingRemovalFiles: 0,
  verifyingFiles: verified ? 0 : 1,
  processingFiles: 0,
  failedFiles: 0,
  nextAttemptAt: verified ? null : new Date(loadedAt + 4000).toISOString(),
  serverTime: new Date().toISOString(),
});
export const recentBidPurges = async () => ({
  data:
    !verified && new URLSearchParams(window.location.search).has("purge-notice")
      ? [purgeFixture()]
      : [],
});
export async function retryPurgeCleanup() {
  if (Date.now() < loadedAt + 4000)
    return { data: { status: purgeFixture(), outcome: "waiting" } };
  verified = true;
  return { data: { status: purgeFixture(), outcome: "processed" } };
}
export async function getManagedAccountOperations() {
  if(new URLSearchParams(location.search).has('account-recovery')) return (await import('./account-actions')).list();
  const {fixture}=await import('./sample-data');
  return {data:{actorId:fixture.profile.id,admin:fixture.profile.role==='admin',operations:[]}};
}
export async function resumeManagedAccountOperation(request:string) {
  return new URLSearchParams(location.search).has('account-recovery') ? (await import('./account-actions')).resume(request) : unavailable();
}
export async function abandonManagedAccountOperation() { return unavailable(); }
export async function submitManagedAccountOperation(request:string,kind:import('@/lib/account-operation-types').AccountKind,fields:Record<string,string>) {
  return new URLSearchParams(location.search).has('account-recovery') ? (await import('./account-actions')).submit(request,kind,fields) : unavailable();
}
