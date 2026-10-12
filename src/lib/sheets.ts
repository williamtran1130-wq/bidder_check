import { normalizeJobUrl } from "./domain";

export const importFields = [
  "company",
  "role_name",
  "url",
  "source",
  "arrangement",
  "job_status",
] as const;
export type ImportField = (typeof importFields)[number];
export type ImportRow = Record<ImportField, string>;
export type ImportError = {
  row: number;
  field: string;
  message: string;
  code?: string;
};
export const fieldLabels: Record<ImportField, string> = {
  company: "Company",
  role_name: "Role",
  url: "Job URL",
  source: "Job site",
  arrangement: "Work arrangement",
  job_status: "Job status",
};

/** Parse clipboard TSV as values only. Quotes follow the Sheets/CSV convention. */
export function parseSheet(text: string, maxRows = 500): string[][] {
  if (new TextEncoder().encode(text).length > 512 * 1024)
    throw new Error("Clipboard limit is 512 KiB.");
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  const pushCell = () => {
    row.push(cell);
    cell = "";
    closed = false;
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += c;
    } else if (c === "\t") pushCell();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      pushRow();
    } else if (c === '"' && !cell && !closed) quoted = true;
    else {
      if (closed) throw new Error("Unexpected text after a quoted cell.");
      cell += c;
    }
  }
  if (quoted) throw new Error("Unclosed quoted cell.");
  pushRow();
  while (rows.length && rows.at(-1)!.every((c) => !c.trim())) rows.pop();
  if (rows.length > maxRows) throw new Error("Import at most 500 rows.");
  return rows;
}
export function mapSheet(
  rows: string[][],
  mapping: (ImportField | "ignore")[],
  defaults: Partial<ImportRow>,
): ImportRow[] {
  const destinations = mapping.filter((f) => f !== "ignore");
  if (new Set(destinations).size !== destinations.length)
    throw new Error("Map each destination only once.");
  return rows.map((row) => {
    const result: ImportRow = {
      company: "",
      role_name: "",
      url: "",
      source: "",
      arrangement: "remote",
      job_status: "open",
      ...defaults,
    };
    mapping.forEach((field, i) => {
      if (field !== "ignore" && row[i]?.trim()) result[field] = row[i].trim();
    });
    result.arrangement = result.arrangement.toLowerCase();
    result.job_status = result.job_status.toLowerCase();
    return result;
  });
}
export function validateImportRows(rows: ImportRow[]): ImportError[] {
  const errors: ImportError[] = [];
  rows.forEach((r, i) => {
    const error = (field: string, message: string) =>
      errors.push({ row: i + 1, field, message });
    for (const f of ["company", "role_name"] as const)
      if (!r[f].trim() || r[f].length > 200)
        error(f, "Required; maximum 200 characters.");
    if (r.source.length > 200) error("source", "Maximum 200 characters.");
    if (!["remote", "onsite", "hybrid"].includes(r.arrangement))
      error("arrangement", "Choose remote, onsite or hybrid.");
    if (!["open", "closed"].includes(r.job_status))
      error("job_status", "Choose open or closed.");
    try {
      if (r.url.length > 4096) throw new Error();
      normalizeJobUrl(r.url);
    } catch {
      error("url", "Enter a valid HTTP/HTTPS URL (maximum 4096 characters).");
    }
  });
  return errors;
}
export function toTsv(rows: string[][]) {
  return rows
    .map((row) =>
      row
        .map((value) =>
          /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value,
        )
        .join("\t"),
    )
    .join("\n");
}
