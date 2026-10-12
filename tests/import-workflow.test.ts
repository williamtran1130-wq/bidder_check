import { expect, it } from "vitest";
import { classifyImportRows, reviewedImportRows } from "@/lib/import-workflow";
import { pastedImage } from "@/lib/clipboard-image";
import type { ImportError, ImportRow } from "@/lib/sheets";

const row = (company: string): ImportRow => ({
  company,
  role_name: "Engineer",
  url: `https://example.test/${encodeURIComponent(company)}`,
  source: "",
  arrangement: "remote",
  job_status: "open",
});

it("classifies blocked rows while keeping the reviewed allowed set and source numbers", () => {
  const rows = [row("Valid"), row('=HYPERLINK("x")'), row("Conflict")];
  const sourceRows = [4, 5, 9];
  const errors: ImportError[] = [
    {
      row: 5,
      field: "url",
      code: "invalid_value",
      message: "Enter a valid URL",
    },
    { row: 9, field: "company", code: "duplicate", message: "Already exists" },
  ];
  expect(classifyImportRows(rows, sourceRows, errors)).toEqual({
    allowed: [rows[0]],
    allowedSourceRows: [4],
    skipped: [
      { sourceRow: 5, row: rows[1], reasons: [errors[0]] },
      { sourceRow: 9, row: rows[2], reasons: [errors[1]] },
    ],
  });
});

it("intersects freshly allowed rows with the originally reviewed source rows", () => {
  const rows = [
    row("Original"),
    row("Originally blocked"),
    row("New conflict"),
  ];
  expect(
    reviewedImportRows(
      rows,
      [3, 7, 10],
      [3, 10],
      [{ row: 10, field: "url", message: "Conflict" }],
    ),
  ).toEqual({ rows: [rows[0]], sourceRows: [3] });
});

it("prefers clipboard image items and falls back to clipboard files", () => {
  const fromItem = new File(["png"], "clip.png", { type: "image/png" });
  const item = { kind: "file", type: "image/png", getAsFile: () => fromItem };
  const items = [item] as unknown as DataTransferItemList;
  const files = [
    new File(["jpg"], "fallback.jpg", { type: "image/jpeg" }),
  ] as unknown as FileList;
  expect(pastedImage(items, files)).toBe(fromItem);
  expect(pastedImage([] as unknown as DataTransferItemList, files)).toBe(
    files[0],
  );
  expect(
    pastedImage(
      [] as unknown as DataTransferItemList,
      [] as unknown as FileList,
    ),
  ).toBeNull();
});
