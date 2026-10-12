import type { ImportError, ImportRow } from "./sheets";

export type SkippedImportRow = {
  sourceRow: number;
  row: ImportRow;
  reasons: ImportError[];
};

export function classifyImportRows(
  rows: ImportRow[],
  sourceRows: number[],
  errors: ImportError[],
) {
  const reasons = new Map<number, ImportError[]>();
  for (const error of errors) {
    const current = reasons.get(error.row) ?? [];
    current.push(error);
    reasons.set(error.row, current);
  }
  const allowed: ImportRow[] = [];
  const allowedSourceRows: number[] = [];
  const skipped: SkippedImportRow[] = [];
  rows.forEach((row, index) => {
    const sourceRow = sourceRows[index] ?? index + 1;
    const rowReasons = reasons.get(sourceRow) ?? [];
    if (rowReasons.length)
      skipped.push({ sourceRow, row, reasons: rowReasons });
    else {
      allowed.push(row);
      allowedSourceRows.push(sourceRow);
    }
  });
  return { allowed, allowedSourceRows, skipped };
}

/** Never broaden the batch beyond the source rows approved in preview. */
export function reviewedImportRows(
  rows: ImportRow[],
  sourceRows: number[],
  approvedSourceRows: number[],
  errors: ImportError[],
) {
  const approved = new Set(approvedSourceRows);
  const fresh = classifyImportRows(rows, sourceRows, errors);
  const indexes = fresh.allowedSourceRows
    .map((sourceRow, index) => ({ sourceRow, index }))
    .filter(({ sourceRow }) => approved.has(sourceRow));
  return {
    rows: indexes.map(({ index }) => fresh.allowed[index]),
    sourceRows: indexes.map(({ sourceRow }) => sourceRow),
  };
}
