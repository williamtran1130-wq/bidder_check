import { expect, it, vi, afterEach } from "vitest";
import { workspaceActorScope } from "@/lib/actor-scope";
const profile = {
  id: "same-user",
  role: "admin",
  approval_status: "approved",
  archived: false,
};
const memberships = [
  { id: "foreign", owner_id: "other" },
  { id: "own", owner_id: "same-user" },
];
afterEach(() => vi.unstubAllGlobals());
it("scopes private workspace reads by identity, role, account state and canonical memberships", () => {
  const original = workspaceActorScope(profile, memberships);
  expect(workspaceActorScope(profile, [...memberships].reverse())).toBe(original);
  for (const change of [
    { id: "other" },
    { role: "client" },
    { approval_status: "pending" },
    { archived: true },
  ])
    expect(workspaceActorScope({ ...profile, ...change }, memberships)).not.toBe(
      original,
    );
  expect(workspaceActorScope(profile, memberships.slice(1))).not.toBe(original);
  expect(
    workspaceActorScope(profile, [
      { id: "foreign", owner_id: "new-owner" },
      memberships[1],
    ]),
  ).not.toBe(original);
});
