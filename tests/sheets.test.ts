import { it, expect } from "vitest";
import { parseSheet, mapSheet, validateImportRows, toTsv } from "@/lib/sheets";
import { chicagoDateRange } from "@/lib/domain";
it("parses quoted Sheets cells, Unicode, newlines and trailing blanks", () => {
  expect(
    parseSheet(
      '"Acme\tInc"\t"Role\nwith ""quotes"""\t\r\n東京\tEngineer\thttps://example.com\r\n\t\t\r\n',
    ),
  ).toEqual([
    ["Acme\tInc", 'Role\nwith "quotes"', ""],
    ["東京", "Engineer", "https://example.com"],
  ]);
});
it("maps reordered columns and fills blank values from shared defaults", () => {
  const rows = mapSheet(
    [["https://example.com", "", "Ignore me"]],
    ["url", "company", "ignore"],
    {
      company: "Acme",
      role_name: "Engineer",
      source: "",
      arrangement: "remote",
      job_status: "open",
    },
  );
  expect(rows).toEqual([
    {
      company: "Acme",
      role_name: "Engineer",
      url: "https://example.com",
      source: "",
      arrangement: "remote",
      job_status: "open",
    },
  ]);
  expect(() => mapSheet([["A", "B"]], ["company", "company"], {})).toThrow(
    /once/,
  );
});
it("reports required fields, bad URLs/enums and normalized duplicates by row", () => {
  const rows = mapSheet(
    [
      ["A", "R", "https://EXAMPLE.com/?utm_source=x"],
      ["B", "R", "https://example.com/"],
    ],
    ["company", "role_name", "url"],
    { arrangement: "remote", job_status: "open" },
  );
  expect(validateImportRows(rows)).toEqual([]);
  expect(validateImportRows([{ ...rows[0], company: "" }, rows[1]])).toEqual([
    expect.objectContaining({ row: 1, field: "company" }),
  ]);
  expect(
    validateImportRows([
      {
        ...rows[0],
        company: "",
        url: "javascript:alert(1)",
        arrangement: "moon",
      },
    ]).map((e) => e.field),
  ).toEqual(expect.arrayContaining(["company", "url", "arrangement"]));
});
it("enforces clipboard and row limits and rejects malformed quotes", () => {
  expect(() => parseSheet("x".repeat(512 * 1024 + 1))).toThrow(/512/);
  expect(() =>
    parseSheet(Array.from({ length: 501 }, () => "row").join("\n")),
  ).toThrow(/500/);
  expect(() => parseSheet('"unfinished')).toThrow(/quoted/);
});
it("round trips selected values as TSV without evaluating formulas", () => {
  const cells = [
    ["=SUM(A1:A2)", "Full\tID"],
    ["line\nbreak", 'a"b'],
  ];
  expect(parseSheet(toTsv(cells))).toEqual(cells);
});
it("Yesterday follows Chicago calendar days across both DST changes", () => {
  expect(
    chicagoDateRange("yesterday", "", "", new Date("2026-03-09T12:00:00Z")),
  ).toEqual({
    from: "2026-03-08T06:00:00.000Z",
    to: "2026-03-09T05:00:00.000Z",
  });
  expect(
    chicagoDateRange("yesterday", "", "", new Date("2026-11-02T12:00:00Z")),
  ).toEqual({
    from: "2026-11-01T05:00:00.000Z",
    to: "2026-11-02T06:00:00.000Z",
  });
});
it("accepts a header plus 500 data rows and applies defaults only to blank cells", () => {
  const source = parseSheet(
    "Company\tRole\tURL\n" +
      Array.from(
        { length: 500 },
        (_, i) => `A\tR\thttps://example.com/${i}`,
      ).join("\n"),
    501,
  );
  expect(source.slice(1)).toHaveLength(500);
  expect(
    mapSheet(
      [["Explicit", "  ", "https://example.com"]],
      ["company", "role_name", "url"],
      { company: "Default", role_name: "Fallback" },
    )[0],
  ).toMatchObject({ company: "Explicit", role_name: "Fallback" });
  expect(() => parseSheet('"closed"oops')).toThrow(/quoted/);
});
it("Yesterday tracks Chicago midnight independently of UTC midnight", () => {
  expect(
    chicagoDateRange("yesterday", "", "", new Date("2026-10-01T04:59:59Z")),
  ).toEqual({
    from: "2026-09-29T05:00:00.000Z",
    to: "2026-09-30T05:00:00.000Z",
  });
  expect(
    chicagoDateRange("yesterday", "", "", new Date("2026-10-01T05:00:00Z")),
  ).toEqual({
    from: "2026-09-30T05:00:00.000Z",
    to: "2026-10-01T05:00:00.000Z",
  });
});
