"use client";

import { Button } from "@/components/ui/button";

export default function WorkspaceError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <section role="alert" className="mx-auto flex max-w-lg flex-col gap-4 py-12">
      <h1 className="text-xl font-semibold">This page could not be loaded</h1>
      <p className="text-muted-foreground">Try loading the page again. If the problem continues, return to your dashboard and reopen this page.</p>
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={retry}>Try again</Button>
        <Button asChild variant="outline"><a href="/dashboard">Return to dashboard</a></Button>
      </div>
      {error.digest && <p className="break-all text-sm text-muted-foreground">Support reference: {error.digest}</p>}
    </section>
  );
}
