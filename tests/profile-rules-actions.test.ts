import { beforeEach, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin", () => ({ adminClient: vi.fn() }));
vi.mock("@/lib/storage-cleanup", () => ({ runStorageCleanup: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getContext: async () => ({ supabase: { rpc } }) }));

import { saveCandidateProfileRules } from "@/app/(workspace)/actions";

const input = {
  profile: "00000000-0000-4000-8000-000000000001",
  companyLimit: 2,
  retentionMonths: 2,
  companies: [] as string[],
  roles: [] as string[],
  links: [] as string[],
};

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: null, error: null });
});

it.each([101, 250, 1000])("saves %i restrictions per list without rejecting or truncating them", async (count) => {
  const companies = Array.from({ length: count }, (_, index) => `Company ${index}`);
  const roles = Array.from({ length: count }, (_, index) => `Role ${index}`);
  const links = Array.from({ length: count }, (_, index) => `blocked-${index}.example`);

  const result = await saveCandidateProfileRules({ ...input, companies, roles, links });

  expect(result.error).toBeUndefined();
  expect(rpc).toHaveBeenCalledExactlyOnceWith("update_candidate_profile_rules", {
    p_profile: input.profile,
    p_company_limit: 2,
    p_retention_months: 2,
    p_companies: companies,
    p_roles: roles,
    p_links: links,
    p_confirm_eligible: null,
  });
});

it("accepts 200-character values and trims surrounding whitespace", async () => {
  const rule = "x".repeat(200);
  const result = await saveCandidateProfileRules({ ...input, companies: [`  ${rule}  `] });

  expect(result.error).toBeUndefined();
  expect(rpc).toHaveBeenCalledWith("update_candidate_profile_rules", expect.objectContaining({ p_companies: [rule] }));
});

it.each(["companies", "roles", "links"] as const)("still rejects blank or overlong entries in %s before saving", async (field) => {
  for (const value of ["   ", "x".repeat(201)]) {
    const result = await saveCandidateProfileRules({ ...input, [field]: [value] });
    expect(result.error).toBeTruthy();
  }
  expect(rpc).not.toHaveBeenCalled();
});

it("allows clearing every restriction list", async () => {
  const result = await saveCandidateProfileRules(input);

  expect(result.error).toBeUndefined();
  expect(rpc).toHaveBeenCalledWith("update_candidate_profile_rules", expect.objectContaining({
    p_companies: [], p_roles: [], p_links: [],
  }));
});
