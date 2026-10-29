import { expect, it } from "vitest";
import { objectIsAbsent } from "../scripts/storage-absence.mjs";
it("recognizes the Storage SDK's explicit missing-object HEAD response", () => {
  expect(objectIsAbsent({ data: false, error: { status: 404 } })).toBe(true);
  expect(objectIsAbsent({ data: false, error: { status: 400 } })).toBe(true);
  expect(
    objectIsAbsent({ data: false, error: { originalError: { status: 404 } } }),
  ).toBe(true);
  expect(objectIsAbsent({ data: false, error: null })).toBe(true);
});
it("never treats authorization failure, network failure or a present object as absence", () => {
  expect(objectIsAbsent({ data: false, error: { status: 403 } })).toBe(false);
  expect(
    objectIsAbsent({ data: false, error: { message: "Network failure" } }),
  ).toBe(false);
  expect(objectIsAbsent({ data: true, error: null })).toBe(false);
});
