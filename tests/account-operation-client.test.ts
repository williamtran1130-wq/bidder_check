import { expect, it } from "vitest";
import {
  freezeAccountRequest,
  readAccountRequest,
  clearAccountRequest,
} from "@/lib/account-operation-client";
class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
it("retains the exact request and frozen nonsecret form across dialog reload and scopes it to actor", () => {
  const storage = new MemoryStorage();
  const initial = freezeAccountRequest(
    storage,
    "actor-a",
    "edit:target",
    {
      kind: "update_client",
      fields: {
        user_id: "target",
        display_name: "Original",
        email: "person@example.test",
        archived: "false",
      },
    },
    () => "request-1",
  );
  const retry = freezeAccountRequest(
    storage,
    "actor-a",
    "edit:target",
    { kind: "update_client", fields: { display_name: "Changed" } },
    () => "request-2",
  );
  expect(retry).toEqual(initial);
  expect(readAccountRequest(storage, "actor-a", "edit:target")?.requestId).toBe(
    "request-1",
  );
  expect(readAccountRequest(storage, "actor-b", "edit:target")).toBeNull();
  clearAccountRequest(storage, "actor-a", "edit:target");
  expect(readAccountRequest(storage, "actor-a", "edit:target")).toBeNull();
});
it("never stores password, tokens or arbitrary form entries", () => {
  const storage = new MemoryStorage();
  const saved = freezeAccountRequest(
    storage,
    "actor",
    "create",
    {
      kind: "create_client",
      fields: {
        display_name: "Name",
        email: "a@example.test",
        password: "secret",
        access_token: "secret",
        other: "secret",
      },
    },
    () => "id",
  );
  expect(saved.fields).toEqual({
    display_name: "Name",
    email: "a@example.test",
  });
});
