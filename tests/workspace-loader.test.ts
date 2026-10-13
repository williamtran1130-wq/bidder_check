import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  role: "bidder",
  records: {} as Record<string, Record<string, unknown>[]>,
  moneyCalls: 0,
}));
vi.mock("../src/lib/auth", () => ({
  getContext: async () => ({
    profile: { id: "viewer", role: state.role },
    workspaces: [],
    supabase: {
      from(table: string) {
        let columns = "*",
          filter: { key: string; value: unknown } | undefined,
          start = 0,
          end = 999;
        const query = {
          select(value: string) {
            columns = value;
            return query;
          },
          eq(key: string, value: unknown) {
            filter = { key, value };
            return query;
          },
          order() {
            return query;
          },
          range(a: number, b: number) {
            start = a;
            end = b;
            return query;
          },
          then(resolve: (value: unknown) => unknown) {
            const rows = (state.records[table] ?? [])
              .filter((row) => !filter || row[filter.key] === filter.value)
              .slice(start, end + 1)
              .map((row) =>
                columns === "*"
                  ? row
                  : Object.fromEntries(
                      columns.split(",").map((key) => [key, row[key]]),
                    ),
              );
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          },
        };
        return query;
      },
      rpc() {
        state.moneyCalls++;
        return Promise.resolve({
          data: { bidders: {}, resumes: {}, bids: {} },
          error: null,
        });
      },
    },
  }),
}));
import { getWorkspaceData } from "../src/lib/data";
beforeEach(() => {
  state.role = "bidder";
  state.records = {};
  state.moneyCalls = 0;
});
it("loads all assignments through page boundaries without transporting bidder money", async () => {
  state.records.resumes = Array.from({ length: 1001 }, (_, i) => ({
    id: String(i),
    bidder_id: "selected",
    workspace_id: "own",
    rate_override_cents: 125,
  }));
  state.records.bidders = [
    { user_id: "selected", workspace_id: "own", default_rate_cents: 125 },
  ];
  const data = await getWorkspaceData({ scope: "resumes" });
  expect(data.resumes).toHaveLength(1001);
  expect(data.resumes[0]).not.toHaveProperty("rate_override_cents");
  expect(data.bidders[0]).not.toHaveProperty("default_rate_cents");
  expect(state.moneyCalls).toBe(0);
});
it("loads first and additional assignable profiles only in the selected bidder workspace", async () => {
  state.records.bidders = [{ user_id: "selected", workspace_id: "own" }];
  state.records.candidate_profiles = [
    { id: "first", workspace_id: "own", archived: false },
    { id: "second", workspace_id: "own", archived: false },
    { id: "historical", workspace_id: "own", archived: true },
    { id: "foreign", workspace_id: "other" },
  ];
  const data = await getWorkspaceData({
    scope: "bidder-detail",
    bidderId: "selected",
  });
  expect(data.candidateProfiles.map((p) => p.id)).toEqual([
    "first",
    "second",
    "historical",
  ]);
});
it("paginates bidder-detail assignments with the selected bidder filter on every page", async () => {
  state.records.bidders = [{ user_id: "selected", workspace_id: "own" }];
  state.records.resumes = [
    ...Array.from({ length: 1001 }, (_, i) => ({
      id: String(i),
      bidder_id: "selected",
    })),
    { id: "foreign", bidder_id: "other" },
  ];
  const data = await getWorkspaceData({
    scope: "bidder-detail",
    bidderId: "selected",
  });
  expect(data.resumes).toHaveLength(1001);
  expect(data.resumes.some((r) => r.id === "foreign")).toBe(false);
});
it('does not enrich unused manager assignment rates on bids, dashboard or notifications, retaining assignment details',async()=>{
 state.role='client';state.records.bidders=[{user_id:'selected',workspace_id:'own',default_rate_cents:42}];
 state.records.resumes=[{id:'resume',bidder_id:'selected',email:'assignment@test',phone:'555',instructions:'Apply carefully',file_id:'pdf',rate_override_cents:12}];
 for(const scope of ['bids','dashboard','notifications'] as const){const data=await getWorkspaceData({scope});expect(data.bidders[0]).not.toHaveProperty('default_rate_cents');if(scope==='bids')expect(data.resumes[0]).toMatchObject({email:'assignment@test',phone:'555',instructions:'Apply carefully',file_id:'pdf'});}
 expect(state.moneyCalls).toBe(0);
});
it('uses typed narrow dashboard filter projections and no manager enrichment',async()=>{
 const api=await import('../src/lib/data');expect(api).toHaveProperty('getDashboardData');
 state.role='client';state.records.profiles=[{id:'selected',display_name:'Bidder',email:'private@test',approval_reason:'private'}];state.records.bidders=[{user_id:'selected',workspace_id:'own',archived:false}];state.records.candidate_profiles=[{id:'candidate',workspace_id:'own',identifier:'ENG',archived:false,instructions:'private'}];
 const data=await api.getDashboardData();expect(data.profiles[0]).toEqual({id:'selected',display_name:'Bidder'});expect(data.candidateProfiles[0]).not.toHaveProperty('instructions');expect(state.moneyCalls).toBe(0);
});
