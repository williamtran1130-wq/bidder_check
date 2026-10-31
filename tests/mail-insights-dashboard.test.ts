import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Dashboard } from "@/components/dashboard";
import type { DashboardData } from "@/lib/data";
const fixture: DashboardData = { profile: { id: "client", display_name: "Alex", email: "alex@example.test", role: "client", approval_status: "approved", approval_reason: null, reviewed_at: null, reviewed_by: null, archived: false, created_at: "2026-10-30T00:00:00Z" }, workspaces: [], profiles: [], bidders: [], candidateProfiles: [] };
it("places Email insights below original comparisons with This week default", () => {
  const html = renderToStaticMarkup(createElement(Dashboard, { data: fixture }));
  expect(html.indexOf('aria-label="Email insights"')).toBeGreaterThan(html.indexOf('aria-label="Application activity"'));
  expect(html.indexOf('aria-label="Email insights"')).toBeGreaterThan(html.indexOf("By profile"));
  expect(html).toContain("Confirmation emails");
  expect(html).toContain("Interview invites");
  expect(html).toContain("Interview rate");
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('<option value="this_week" selected="">This week</option>');
  expect(html).toContain("By profile");
});
