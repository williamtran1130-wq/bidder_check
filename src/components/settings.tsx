"use client";
import { refreshWorkspace } from "@/lib/report-cache";
import { useState, useTransition } from "react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sun, Moon, Monitor } from "lucide-react";
import type { WorkspaceData } from "@/lib/data";
import { saveSettings } from "@/app/(workspace)/actions";
import { PageHeading, Field, SelectField, SaveButton } from "./common";
import { Button } from "./ui/button";
import Link from "next/link";
export function Settings({ data }: { data: WorkspaceData }) {
  const workspaces = data.selectableWorkspaces ?? data.workspaces;
  const [workspaceSelection, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const workspaceId = workspaces.some(row => row.id === workspaceSelection) ? workspaceSelection : workspaces[0]?.id ?? "";
  const w = workspaces.find((w) => w.id === workspaceId);
  const [pending, start] = useTransition();
  const { setTheme } = useTheme();
  const router = useRouter();
  return (
    <>
      <PageHeading
        eyebrow="MAKE YOURSELF AT HOME"
        title="Your workspace, your way."
        description="Manage the little details that make your workday better."
      />
      <div className="max-w-3xl space-y-6">
        <form
          className="panel space-y-5 p-6"
          action={(form) =>
            start(async () => {
              const result = await saveSettings(form);
              if (result.error) toast.error(result.error);
              else {
                toast.success("Settings saved");
                refreshWorkspace(router);
              }
            })
          }
        >
          <div>
            <h2 className="font-semibold">Personal details</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              How you appear in your workspace.
            </p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Display name"
              name="display_name"
              defaultValue={data.profile.display_name}
              required
            />
            <Field
              label="Email address"
              type="email"
              value={data.profile.email}
              disabled
            />
          </div>
          {data.profile.role !== "bidder" && w && (
            <>
              <div className="border-t pt-5">
                <h2 className="font-semibold">Workspace preferences</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Reports use Central Time (America/Chicago), including daylight
                  saving time. Your saved workspace timezone does not change
                  reporting boundaries.
                </p>
              </div>
              {data.profile.role === "admin" && (
                <SelectField
                  label="Workspace"
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                >
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </SelectField>
              )}
              <input type="hidden" name="workspace_id" value={w.id} />
              <div className="grid gap-5 sm:grid-cols-2" key={w.id}>
                <Field
                  label="Workspace name"
                  name="workspace_name"
                  defaultValue={w.name}
                  required
                />
                <Field
                  label="Workspace timezone"
                  name="timezone"
                  defaultValue={w.timezone}
                  list="timezones"
                  required
                />
                <datalist id="timezones">
                  {Intl.supportedValuesOf("timeZone").map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </div>
            </>
          )}
          <div className="flex justify-end border-t pt-5">
            <SaveButton pending={pending} />
          </div>
        </form>
        <section className="panel p-6">
          <h2 className="font-semibold">Appearance</h2>
          <p className="mb-5 mt-1 text-xs text-muted-foreground">
            Choose the view that feels right.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              { name: "Light", value: "light", icon: Sun },
              { name: "Dark", value: "dark", icon: Moon },
              { name: "System", value: "system", icon: Monitor },
            ].map((t) => (
              <Button
                key={t.value}
                variant="outline"
                className="h-16"
                onClick={() => setTheme(t.value)}
              >
                <t.icon size={18} />
                {t.name}
              </Button>
            ))}
          </div>
        </section>
        <section className="panel flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold">Account security</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Keep your password up to date.
            </p>
          </div>
          <Button variant="outline" asChild>
            <Link href="/auth/update-password">Change password</Link>
          </Button>
        </section>
      </div>
    </>
  );
}
