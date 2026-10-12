"use client";
import { useEffect, useRef, useState } from "react";
import { flexRender, type Table } from "@tanstack/react-table";
import { formatInTimeZone } from "date-fns-tz";
import type { BidRow } from "@/lib/workspace-types";
import type { WorkspaceData } from "@/lib/data";
import { BID_TIMEZONE } from "@/lib/domain";
import { toTsv } from "@/lib/sheets";
import { updateBidCell } from "@/app/(workspace)/actions";
import { Button } from "./ui/button";
type Bid = BidRow;
type Point = { r: number; c: number };
type Edit = {
  id: string;
  field: string;
  value: string;
  version: number;
  point: Point;
  error?: string;
  latest?: Bid;
};
const fields = [
  "company",
  "role_name",
  "url",
  "source",
  "arrangement",
  "job_status",
  "resume_id",
];
export function BidGrid({
  table,
  data,
  onRow,
  onBusy,
  onPaste,
  onOpen,
  emptyMessage,
  checked,
  onCheck,
  disabled = false,
}: {
  checked: Record<string, { version: number; applied?: boolean }>;
  onCheck: (rows: Bid[], value: boolean) => void;
  disabled?: boolean;
  table: Table<Bid>;
  data: WorkspaceData;
  onRow: (row: Bid) => void;
  onBusy: (busy: boolean) => void;
  onPaste: (text: string) => void;
  onOpen: (bid: Bid) => void;
  emptyMessage: string;
}) {
  const [selection, setSelection] = useState<{
    anchor: Point;
    end: Point;
  } | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null),
    [saving, setSaving] = useState(false),
    [saved, setSaved] = useState("");
  const container = useRef<HTMLDivElement>(null),
    focusFrame = useRef(0),
    dragging = useRef(false),
    busy = useRef(false),
    completedEdit = useRef(false),
    editor = useRef<HTMLInputElement & HTMLSelectElement>(null);
  const rows = table.getRowModel().rows,
    columns = table.getVisibleLeafColumns();
  useEffect(() => {
    const stop = () => {
      dragging.current = false;
    };
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      cancelAnimationFrame(focusFrame.current);
    };
  }, []);
  useEffect(() => {
    if (edit) {
      editor.current?.focus();
      if (editor.current instanceof HTMLInputElement) editor.current.select();
    }
  }, [edit?.id, edit?.field]); // eslint-disable-line react-hooks/exhaustive-deps
  function focus(point: Point) {
    cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() =>
      container.current
        ?.querySelector<HTMLElement>(
          `[data-grid-r="${point.r}"][data-grid-c="${point.c}"]`,
        )
        ?.focus(),
    );
  }
  function select(point: Point, extend = false) {
    setSelection((previous) => ({
      anchor: extend && previous ? previous.anchor : point,
      end: point,
    }));
    focus(point);
  }
  function startEdit(point: Point) {
    cancelAnimationFrame(focusFrame.current);
    dragging.current = false;
    const bid = rows[point.r]?.original,
      field = columns[point.c]?.id;
    if (disabled || !bid || bid.deleted_at) return;
    if (field === "applied") {
      if (data.profile.role !== "bidder") onOpen(bid);
      return;
    }
    if (
      !fields.includes(field) ||
      (field === "resume_id" && bid.first_applied_at)
    )
      return;
    setSaved("");
    completedEdit.current = false;
    setEdit({
      id: bid.id,
      field,
      value: String(bid[field as keyof Bid] ?? ""),
      version: bid.version,
      point,
    });
    onBusy(true);
  }
  function cancel() {
    if (busy.current) return;
    const point = edit?.point;
    setEdit(null);
    onBusy(false);
    if (point) focus(point);
  }
  async function save(next?: Point) {
    if (!edit || busy.current || completedEdit.current || edit.latest) return;
    busy.current = true;
    setSaving(true);
    try {
      const result = await updateBidCell(
        edit.id,
        edit.field,
        edit.value,
        edit.version,
      );
      if (result.error) setEdit({ ...edit, error: result.error });
      else if (result.data?.conflict)
        setEdit({
          ...edit,
          error:
            "Changed by another action. Review the latest value before retrying.",
          latest: result.data.row,
        });
      else if (result.data?.ok) {
        // React may blur the old editor before committing setEdit(null).
        // Prevent that blur from resubmitting the version already saved.
        completedEdit.current = true;
        onRow(result.data.row);
        setEdit(null);
        onBusy(false);
        setSaved(`${edit.id}:${edit.field}`);
        if (next) select(next);
        else focus(edit.point);
      }
    } catch {
      setEdit({
        ...edit,
        error: "Could not save. Your draft is kept; retry or cancel.",
      });
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  function value(bid: Bid, field: string): string {
    if (field === "resume_id")
      return data.candidateProfiles.find((p) => p.id === data.resumes.find((r) => r.id === bid.resume_id)?.profile_id)?.identifier ?? "";
    if (field === "applied") return bid.applied ? "Applied" : "Unapplied";
    if (field === "found_at" || field === "applied_at")
      return bid[field]
        ? formatInTimeZone(bid[field]!, BID_TIMEZONE, "yyyy-MM-dd HH:mm:ss") +
            " CT"
        : "";
    if (field === "screenshot")
      return bid.evidence_file_id ? "Screenshot available" : "";
    if (field === "actions") return "";
    return String(bid[field as keyof Bid] ?? "");
  }
  const inSelection = (r: number, c: number) =>
    selection &&
    r >= Math.min(selection.anchor.r, selection.end.r) &&
    r <= Math.max(selection.anchor.r, selection.end.r) &&
    c >= Math.min(selection.anchor.c, selection.end.c) &&
    c <= Math.max(selection.anchor.c, selection.end.c);
  return (
    <div
      ref={container}
      className="max-h-[70vh] min-h-56 overflow-auto"
      tabIndex={0}
      role="region"
      aria-label="Bid table, scroll horizontally for all columns"
      onCopy={(e) => {
        if (edit || !selection) return;
        const values = [];
        for (
          let r = Math.min(selection.anchor.r, selection.end.r);
          r <= Math.max(selection.anchor.r, selection.end.r);
          r++
        ) {
          const line = [];
          for (
            let c = Math.min(selection.anchor.c, selection.end.c);
            c <= Math.max(selection.anchor.c, selection.end.c);
            c++
          )
            if (rows[r] && columns[c])
              line.push(value(rows[r].original, columns[c].id));
          values.push(line);
        }
        e.clipboardData.setData("text/plain", toTsv(values));
        e.preventDefault();
      }}
      onPaste={(e) => {
        if (
          edit || e.defaultPrevented || !selection ||
          (e.target as HTMLElement).closest("[data-grid-interactive]")
        ) return;
        const text = e.clipboardData.getData("text/plain");
        if (text.includes("\t") || text.includes("\n")) {
          e.preventDefault();
          onPaste(text);
        }
      }}
      onKeyDown={(e) => {
        if (
          edit ||
          !selection ||
          (e.target as HTMLElement).closest("button,a,input,select,textarea")
        )
          return;
        const p = selection.end;
        if (["Enter", "F2"].includes(e.key)) {
          e.preventDefault();
          startEdit(p);
          return;
        }
        const moves: Record<string, [number, number]> = {
          ArrowUp: [-1, 0],
          ArrowDown: [1, 0],
          ArrowLeft: [0, -1],
          ArrowRight: [0, 1],
        };
        const move = moves[e.key];
        if (move) {
          e.preventDefault();
          select(
            {
              r: Math.max(0, Math.min(rows.length - 1, p.r + move[0])),
              c: Math.max(0, Math.min(columns.length - 1, p.c + move[1])),
            },
            e.shiftKey,
          );
        }
      }}
    >
      <table
        role="grid"
        aria-label="Bid applications"
        aria-multiselectable="true"
        className="w-full border-collapse text-left text-xs"
      >
        <thead className="sticky top-0 z-10 bg-background shadow-sm">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              <th className="border px-2 py-2">
                <input
                  type="checkbox"
                  aria-label="Select current page"
                  disabled={disabled || !!edit}
                  checked={
                    rows.length > 0 &&
                    rows.every((row) => checked[row.id] !== undefined)
                  }
                  ref={(element) => {
                    if (element)
                      element.indeterminate =
                        rows.some((row) => checked[row.id] !== undefined) &&
                        !rows.every((row) => checked[row.id] !== undefined);
                  }}
                  onChange={(e) =>
                    onCheck(
                      rows.map((row) => row.original),
                      e.target.checked,
                    )
                  }
                />
              </th>
              <th className="border px-2 py-2" aria-label="Row number">
                #
              </th>
              {group.headers.map((header) => (
                <th
                  key={header.id}
                  aria-sort={(() => {
                    const sort = table.getState().sorting[0];
                    if (sort?.id !== header.column.id && !(header.column.id === "screenshot" && sort?.id === "screenshot_size_bytes")) return undefined;
                    return sort.desc ? "descending" : "ascending";
                  })()}
                  className="whitespace-nowrap border px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length + 2} className="h-48 border px-6 text-center text-sm text-muted-foreground">
                {emptyMessage}
              </td>
            </tr>
          )}
          {rows.map((row, r) => (
            <tr key={row.id} className="hover:bg-muted/30">
              <td className="border px-2 py-2">
                <input
                  type="checkbox"
                  aria-label={`Select bid at ${row.original.company}`}
                  disabled={disabled || !!edit}
                  checked={checked[row.id] !== undefined}
                  onChange={(e) => onCheck([row.original], e.target.checked)}
                />
              </td>
              <th
                scope="row"
                className="border bg-muted/30 px-2 text-center text-muted-foreground"
              >
                {table.getState().pagination.pageIndex *
                  table.getState().pagination.pageSize +
                  r +
                  1}
              </th>
              {row.getVisibleCells().map((cell, c) => {
                const isEditing =
                  edit?.id === row.original.id && edit.field === cell.column.id;
                const point = { r, c };
                const selected = inSelection(r, c);
                const active = selection?.end.r === r && selection?.end.c === c;
                const options =
                  cell.column.id === "arrangement"
                    ? ["remote", "onsite", "hybrid"]
                    : cell.column.id === "job_status"
                      ? ["open", "closed"]
                      : null;
                return (
                  <td
                    role="gridcell"
                    aria-selected={!!selected}
                    aria-readonly={
                      !!row.original.deleted_at ||
                      !fields.includes(cell.column.id) ||
                      (cell.column.id === "resume_id" &&
                        !!row.original.first_applied_at)
                    }
                    key={cell.id}
                    data-grid-r={r}
                    data-grid-c={c}
                    data-field={cell.column.id}
                    tabIndex={
                      active || (!selection && r === 0 && c === 0) ? 0 : -1
                    }
                    className={`relative min-w-24 border px-3 py-2 align-middle outline-none ${selected ? "bg-primary/10" : ""} ${active ? "ring-2 ring-inset ring-primary" : ""}`}
                    onFocus={(e) => {
                      if (e.target === e.currentTarget && !selection && !edit)
                        setSelection({ anchor: point, end: point });
                    }}
                    onKeyDown={(e) => {
                      if (edit || (e.target as HTMLElement).closest("button,a,input,select,textarea")) return;
                      if (e.key === "Enter" || e.key === "F2") {
                        e.preventDefault();
                        e.stopPropagation();
                        startEdit(point);
                      }
                    }}
                    onPointerDown={(e) => {
                      if ((e.target as HTMLElement).closest("button,a,input,select,textarea,[data-grid-interactive]")) {
                        dragging.current = false;
                        return;
                      }
                      if (edit) return;
                      dragging.current = true;
                      select(point, e.shiftKey);
                      if (
                        !(e.target as HTMLElement).closest(
                          "button,a,input,select",
                        )
                      )
                        e.preventDefault();
                    }}
                    onPointerEnter={() => {
                      if (dragging.current && !edit) select(point, true);
                    }}
                    onDoubleClick={(e) => {
                      if ((e.target as HTMLElement).closest("button,a")) return;
                      startEdit(point);
                    }}
                  >
                    {isEditing ? (
                      <div
                        className="min-w-52"
                        onBlur={(e) => {
                          if (
                            !e.currentTarget.contains(e.relatedTarget) &&
                            !edit.error
                          )
                            void save();
                        }}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Escape") {
                            e.preventDefault();
                            cancel();
                          } else if (e.key === "Enter" || e.key === "Tab") {
                            e.preventDefault();
                            const offset = e.shiftKey ? -1 : 1;
                            const idx = r * columns.length + c + offset;
                            const next =
                              e.key === "Tab"
                                ? {
                                    r: Math.max(
                                      0,
                                      Math.min(
                                        rows.length - 1,
                                        Math.floor(idx / columns.length),
                                      ),
                                    ),
                                    c: (idx + columns.length) % columns.length,
                                  }
                                : point;
                            void save(next);
                          }
                        }}
                      >
                        {options || cell.column.id === "resume_id" ? (
                          <select
                            ref={editor}
                            aria-label={`Edit ${cell.column.id}`}
                            className="h-8 w-full rounded border bg-background px-2"
                            disabled={saving}
                            value={edit.value}
                            onChange={(e) =>
                              setEdit({
                                ...edit,
                                value: e.target.value,
                                error: undefined,
                              })
                            }
                          >
                            {options
                              ? options.map((v) => <option key={v}>{v}</option>)
                              : data.resumes
                                  .filter(
                                    (v) =>
                                      v.bidder_id === row.original.bidder_id &&
                                      !v.archived &&
                                      !!v.file_id,
                                  )
                                  .map((v) => (
                                    <option key={v.id} value={v.id}>
                                      {data.candidateProfiles.find((p) => p.id === v.profile_id)?.identifier ?? "Profile"}
                                    </option>
                                  ))}
                          </select>
                        ) : (
                          <input
                            ref={editor}
                            aria-label={`Edit ${cell.column.id}`}
                            className="h-8 w-full rounded border bg-background px-2"
                            disabled={saving}
                            value={edit.value}
                            onChange={(e) =>
                              setEdit({
                                ...edit,
                                value: e.target.value,
                                error: undefined,
                              })
                            }
                          />
                        )}
                        {saving && <p role="status">Saving...</p>}
                        {edit.error && (
                          <p
                            role="alert"
                            className="max-w-64 whitespace-normal text-destructive"
                          >
                            {edit.error}
                          </p>
                        )}
                        {edit.latest && (
                          <div className="max-w-64 whitespace-normal">
                            <p>Latest: {value(edit.latest, edit.field)}</p>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                setEdit({
                                  ...edit,
                                  version: edit.latest!.version,
                                  latest: undefined,
                                  error: undefined,
                                })
                              }
                            >
                              Use latest version and keep draft
                            </Button>
                          </div>
                        )}
                        <div className="mt-1 flex gap-1">
                          <Button
                            size="sm"
                            disabled={saving || !!edit.latest}
                            onClick={() => void save()}
                          >
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={saving}
                            onClick={cancel}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {typeof cell.column.columnDef.cell === "function"
                          ? cell.column.columnDef.cell(cell.getContext())
                          : flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext(),
                            )}
                        {saved === `${row.original.id}:${cell.column.id}` && (
                          <span
                            role="status"
                            className="block text-[10px] text-emerald-600"
                          >
                            Saved
                          </span>
                        )}
                      </>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
