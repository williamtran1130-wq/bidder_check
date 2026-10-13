"use client";
import { useId, useState, useTransition } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Badge } from "./ui/badge";
import { LoaderCircle, Inbox, ArrowUpRight } from "lucide-react";
import { getFileUrl } from "@/lib/read-client";
import { toast } from "sonner";
export function PageHeading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-2.5">{eyebrow}</p>}
        <h1 className="text-[28px] font-semibold tracking-[-1px]">{title}</h1>
        <p className="mt-2 text-[13px] text-muted-foreground">{description}</p>
      </div>
      {children && (
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      )}
    </div>
  );
}
export function Field({
  label,
  children,
  ...props
}: React.ComponentProps<typeof Input> & {
  label: string;
  children?: React.ReactNode;
}) {
  const auto = useId();
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={props.id ?? auto} className="text-xs">
        {label}
      </Label>
      {children ?? <Input {...props} id={props.id ?? auto} />}
    </div>
  );
}
export function SelectField({
  label,
  children,
  ...props
}: React.ComponentProps<"select"> & { label: string }) {
  const auto = useId();
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={props.id ?? auto} className="text-xs">
        {label}
      </Label>
      <select {...props} id={props.id ?? auto} className="native-select">
        {children}
      </select>
    </div>
  );
}
export function AppliedBadge({ applied }: { applied: boolean }) {
  return (
    <Badge
      variant="secondary"
      className={
        applied
          ? "gap-1.5 border-0 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "gap-1.5 border-0 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      }
    >
      <span
        className={`size-1 rounded-full ${applied ? "bg-emerald-500" : "bg-amber-500"}`}
      />
      {applied ? "Applied" : "Unapplied"}
    </Badge>
  );
}
export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center py-16 text-center">
      <span className="mb-5 flex size-14 items-center justify-center rounded-2xl border bg-background text-primary">
        <Inbox size={24} strokeWidth={1.5} />
      </span>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mb-5 mt-2 max-w-sm px-4 text-sm leading-6 text-muted-foreground">
        {description}
      </p>
      {children}
    </div>
  );
}
export function SaveButton({
  pending,
  label = "Save changes",
}: {
  pending: boolean;
  label?: string;
}) {
  return (
    <Button disabled={pending} type="submit">
      {pending && <LoaderCircle className="animate-spin" />}
      {pending ? "Saving…" : label}
    </Button>
  );
}
export function FileButton({
  id,
  label = "Open file",
}: {
  id: string;
  label?: string;
}) {
  const [pending, start] = useTransition();
  const [url, setUrl] = useState<string>();
  return (
    <div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await getFileUrl(id);
            if (result.error) toast.error(result.error);
            else if (result.data) setUrl(result.data.url);
          })
        }
      >
        {pending ? (
          <LoaderCircle className="animate-spin" />
        ) : (
          <ArrowUpRight size={14} />
        )}{" "}
        {label}
      </Button>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-3 text-xs font-medium text-primary"
        >
          View securely ↗
        </a>
      )}
    </div>
  );
}
