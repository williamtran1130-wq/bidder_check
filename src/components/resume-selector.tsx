"use client";
import { useId, useMemo, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { filterResumeOptions, type ResumeOption } from "@/lib/resume-options";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function ResumeSelector({ options, value, onChange, disabled = false }: {
  options: ResumeOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(50);
  const [active, setActive] = useState("all");
  const matches = useMemo(() => filterResumeOptions(options, search).sort((a, b) => a.primary.localeCompare(b.primary) || a.groupId.localeCompare(b.groupId) || a.secondary.localeCompare(b.secondary) || a.id.localeCompare(b.id)), [options, search]);
  const selected = options.find((option) => option.id === value);
  const page = matches.slice(0, limit);
  const pinned = selected && !page.some((option) => option.id === selected.id) ? selected : undefined;
  const visible = pinned ? [pinned, ...page] : page;
  const groups = new Map<string, ResumeOption[]>();
  for (const option of visible) {
    if (!groups.has(option.groupId)) groups.set(option.groupId, []);
    groups.get(option.groupId)!.push(option);
  }
  const choices = ["all", ...[...groups.values()].flat().map((option) => option.id)];
  function choose(next: string) { onChange(next); setOpen(false); }
  function move(next: string) {
    setActive(next);
    document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: "nearest" });
  }
  return <div className="min-w-0 space-y-2">
    <Label htmlFor={`${id}-trigger`} className="text-xs">Resume</Label>
    <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) { setSearch(""); setLimit(50); setActive(selected?.id ?? "all"); } }}>
      <Popover.Trigger asChild>
        <Button id={`${id}-trigger`} type="button" variant="outline" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} className="h-auto min-h-10 w-full justify-between px-3 py-2 text-left font-normal">
          <span className="min-w-0 break-words whitespace-normal text-xs">{selected ? <><span className="block font-medium">{selected.primary}</span><span className="block text-muted-foreground">{selected.secondary}</span></> : "All resumes"}</span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 text-muted-foreground" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal><Popover.Content align="start" sideOffset={4} collisionPadding={12} onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus(); }} className="z-50 w-[min(30rem,calc(100vw-1.5rem))] rounded-lg border bg-popover text-popover-foreground shadow-lg">
        <div className="relative border-b p-2"><Search className="pointer-events-none absolute left-5 top-5 size-4 text-muted-foreground" /><Input ref={input} role="combobox" aria-label="Search resume assignments" aria-controls={`${id}-list`} aria-expanded={open} aria-autocomplete="list" aria-activedescendant={choices.includes(active) ? `${id}-${active}` : undefined} placeholder="Search profile, bidder, or email" value={search} className="pl-9" onChange={(event) => { setSearch(event.target.value); setLimit(50); setActive("all"); }} onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const index = choices.indexOf(active); move(choices[Math.max(0, Math.min(choices.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]); }
          if (event.key === "Enter") { event.preventDefault(); choose(choices.includes(active) ? active : "all"); }
        }} /></div>
        <p role="status" aria-live="polite" className="px-3 py-2 text-xs text-muted-foreground">{matches.length} matching resume assignment{matches.length === 1 ? "" : "s"}{matches.length > limit ? ` · Showing ${page.length}` : ""}{pinned ? " · Current selection also shown" : ""}</p>
        <div id={`${id}-list`} role="listbox" aria-label="Resume assignments" className="max-h-[min(20rem,45dvh)] overflow-y-auto p-1">
          <button type="button" id={`${id}-all`} role="option" aria-selected={value === "all"} tabIndex={-1} onMouseDown={(event) => event.preventDefault()} onClick={() => choose("all")} className={`flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm ${active === "all" ? "bg-accent" : "hover:bg-accent"}`}>All resumes{value === "all" && <Check className="size-4" />}</button>
          {[...groups].map(([groupId, group]) => <div key={groupId} role="group" aria-labelledby={`${id}-group-${groupId}`}>
            <p id={`${id}-group-${groupId}`} className="break-words px-3 pb-1 pt-3 text-xs font-semibold">{group[0].primary}</p>
            {group.map((option) => <button key={option.id} type="button" id={`${id}-${option.id}`} role="option" aria-label={option.label} aria-selected={value === option.id} tabIndex={-1} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option.id)} className={`flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-xs ${active === option.id ? "bg-accent" : "hover:bg-accent"}`}><span className="break-words">{option.secondary}</span>{value === option.id && <Check className="size-4 shrink-0" />}</button>)}
          </div>)}
          {!matches.length && <p className="p-3 text-xs text-muted-foreground">No matching resume assignments.</p>}
        </div>
        {matches.length > limit && <div className="border-t p-2"><Button type="button" variant="ghost" className="w-full" onClick={() => { setLimit((current) => current + 50); input.current?.focus(); }}>Show 50 more</Button></div>}
      </Popover.Content></Popover.Portal>
    </Popover.Root>
  </div>;
}
