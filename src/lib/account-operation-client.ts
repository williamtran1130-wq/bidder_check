import type { AccountKind } from "./account-operation-types";
export type FrozenAccountRequest = {
  requestId: string;
  kind: AccountKind;
  fields: Record<string, string>;
};
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const key = (actor: string, scope: string) =>
  `managed-account:${actor}:${scope}`;
const fields = new Set([
  "user_id",
  "workspace_id",
  "display_name",
  "email",
  "rate",
  "archived",
]);
export function readAccountRequest(
  storage: Store,
  actor: string,
  scope: string,
): FrozenAccountRequest | null {
  const saved = storage.getItem(key(actor, scope));
  if (!saved) return null;
  const value = JSON.parse(saved) as FrozenAccountRequest;
  if (!value.requestId || !value.kind || !value.fields)
    throw new Error(
      "Stored account request needs review. Use pending account recovery.",
    );
  return value;
}
export function freezeAccountRequest(
  storage: Store,
  actor: string,
  scope: string,
  input: Omit<FrozenAccountRequest, "requestId">,
  uuid = () => crypto.randomUUID(),
): FrozenAccountRequest {
  const existing = readAccountRequest(storage, actor, scope);
  if (existing) return existing;
  const value = {
    requestId: uuid(),
    kind: input.kind,
    fields: Object.fromEntries(
      Object.entries(input.fields).filter(([name]) => fields.has(name)),
    ),
  };
  storage.setItem(key(actor, scope), JSON.stringify(value));
  return value;
}
export function clearAccountRequest(
  storage: Store,
  actor: string,
  scope: string,
) {
  storage.removeItem(key(actor, scope));
}
