import type { WorkspaceData } from "@/lib/data";
import type { ComparisonRow } from "@/lib/report-types";
const now = new Date().toISOString();
export const longWorkspaceName = "Workspace - Alexandra Catherine Montgomery Rivera and the International Candidate Operations Team";
export function comparisonFixtures(scenario: string): ComparisonRow[] {
  if (scenario === "empty") return [];
  const mixed = { id: "group-a", label: "ENG-01", found: 10, foundApplied: 6, arrangements: {
    remote: { found: 5, foundApplied: 3 }, onsiteHybrid: { found: 3, foundApplied: 2 }, unspecified: { found: 2, foundApplied: 1 },
  } };
  if (scenario === "unavailable") return [{ id: "group-a", label: "ENG-01", found: 10, foundApplied: 6 }];
  if (scenario === "unknown") return [{ ...mixed, arrangements: {
    remote: { found: 0, foundApplied: 0 }, onsiteHybrid: { found: 0, foundApplied: 0 }, unspecified: { found: 10, foundApplied: 6 },
  } }];
  if (scenario === "ten") return [...Array.from({ length: 11 }, (_, i) => ({
    id: `group-${String(i + 1).padStart(2, "0")}`, label: `Profile ${String(i + 1).padStart(2, "0")}`, found: 10, foundApplied: 6,
    arrangements: { remote: { found: 10, foundApplied: 6 }, onsiteHybrid: { found: 0, foundApplied: 0 }, unspecified: { found: 0, foundApplied: 0 } },
  })).reverse(), { ...mixed, id: "group-00", label: "A full candidate profile name that must remain readable on narrow screens", found: 12, foundApplied: 6,
    arrangements: { remote: { found: 7, foundApplied: 3 }, onsiteHybrid: { found: 3, foundApplied: 2 }, unspecified: { found: 2, foundApplied: 1 } },
  }];
  return [mixed];
}
const profile = {
  id: "client",
  display_name: "Alex Morgan",
  email: "alex@example.test",
  role: "client",
  approval_status: "approved",
  approval_reason: null,
  reviewed_at: null,
  reviewed_by: null,
  archived: false,
  created_at: now,
};
const people = ["Jamie Parker", "Taylor Reed", "Sam Rivera"].map((name, i) => ({
  id: `bidder-${i}`,
  display_name: name,
  email: `bidder${i}@example.test`,
  role: "bidder",
  approval_status: "approved",
  approval_reason: null,
  reviewed_at: null,
  reviewed_by: null,
  archived: false,
  created_at: now,
}));
const bidders = people.map((p) => ({
  user_id: p.id,
  workspace_id: "workspace",
  default_rate_cents: 125,
  archived: false,
}));
const resumes = people.map((p, i) => ({
  id: `resume-${i}`,
  workspace_id: "workspace",
  bidder_id: p.id,
  profile_id: `profile-${p.id}`,
  identifier: ["ENG-01", "FULLSTACK-02", "DESIGN-03"][i],
  candidate_name: p.display_name,
  email: p.email,
  phone: "+1 (555) 010-2000",
  address: "Chicago, IL",
  links: "https://example.test/portfolio",
  instructions:
    "Focus on remote roles. Use the attached resume and include the portfolio link.",
  rate_override_cents: null,
  file_id: "resume-file",
  archived: false,
  created_at: now,
}));
const candidateProfiles = people.map((p, i) => ({
  id: `profile-${p.id}`,
  workspace_id: "workspace",
  identifier: ["ENG-01", "FULLSTACK-02", "DESIGN-03"][i],
  candidate_name: p.display_name,
  address: "Chicago, IL",
  links: "https://example.test/portfolio",
  instructions:
    "Focus on remote roles. Use the attached resume and include the portfolio link.",
  max_bids_per_company: 3,
  restricted_companies: [],
  restricted_roles: [],
  restricted_links: [],
  retention_months: 3,
  archived: false,
  created_at: now,
  updated_at: now,
}));
const companies = [
  "Linear",
  "Notion",
  "Vercel",
  "Figma",
  "Stripe",
  "Webflow",
  "GitHub",
  "Framer",
  "Ramp",
  "Retool",
  "Loom",
  "Supabase",
];
const roles = [
  "Senior Frontend Engineer",
  "Full Stack Developer",
  "Product Engineer",
  "UI Engineer",
  "Software Engineer",
  "Design Engineer",
];
export const fixture: WorkspaceData = {
  profile,
  workspaces: [
    {
      id: "workspace",
      owner_id: "client",
      name: "Northstar Studio",
      timezone: "America/Chicago",
      created_at: now,
    },
  ],
  profiles: [profile, ...people],
  bidders,
  resumes,
  candidateProfiles,
  historicalAggregates: [],
  bidCounts: { "resume-0": 2 },
  invitations: [],
  bids: companies.map((company, i) => ({
    id: `bid-${i}`,
    workspace_id: "workspace",
    bidder_id: people[i % 3].id,
    resume_id: resumes[i % 3].id,
    company,
    role_name: roles[i % 6],
    url: `https://example.test/${i}`,
    normalized_url: `https://example.test/${i}`,
    source: ["LinkedIn", "Company website", "Indeed", "Wellfound"][i % 4],
    arrangement: i % 3 === 0 ? "hybrid" : "remote",
    job_status: "open",
    applied: i % 3 !== 0,
    application_method: i % 3 !== 0 ? "screenshot" : null,
    found_at: new Date(Date.now() - i * 86400000).toISOString(),
    applied_at: i % 3 !== 0 ? now : null,
    first_applied_at: i % 3 !== 0 ? now : null,
    rate_cents: i % 3 !== 0 ? 125 : null,
    evidence_file_id: i % 3 !== 0 ? "file" : null,
    rejected_hashes: [],
    version: 0,
    deleted_at: null,
    deleted_by: null,
    review_status: i % 3 !== 0 ? "approved" : "pending",
    review_revision: 1,
    reviewed_by: i % 3 !== 0 ? "client" : null,
    reviewed_at: i % 3 !== 0 ? now : null,
    review_reason: null,
    interview_scheduled: i % 7 === 0 && i % 3 !== 0,
    interview_at: i % 7 === 0 && i % 3 !== 0 ? now : null,
    interview_notes: "",
    interview_updated_by: i % 7 === 0 ? "client" : null,
    interview_updated_at: i % 7 === 0 ? now : null,
    interview_tracking: true,
    created_at: new Date(Date.now() - i * 86400000).toISOString(),
  })),
};

// A real bidder-shaped transport fixture: no monetary keys or teammate rows.
if (new URLSearchParams(window.location.search).get("role") === "bidder") {
  fixture.profile = { ...people[0], role: "bidder" };
  fixture.profiles = [fixture.profile];
  fixture.bidders = fixture.bidders.filter((row) => row.user_id === fixture.profile.id).map((row) => {
    const safe = { ...row }; delete safe.default_rate_cents; return safe;
  });
  fixture.resumes = fixture.resumes.filter((row) => row.bidder_id === fixture.profile.id).map((row) => {
    const safe = { ...row }; delete safe.rate_override_cents; return safe;
  });
  fixture.candidateProfiles = fixture.candidateProfiles.filter((row) => fixture.resumes.some((assignment) => assignment.profile_id === row.id));
  fixture.bids = fixture.bids.filter((row) => row.bidder_id === fixture.profile.id).map((row) => {
    const safe = { ...row }; delete safe.rate_cents; return safe;
  });
}
