"use client";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { WorkspaceData } from "@/lib/data";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { PageHeading } from "./common";
import { EditPerson } from "./people";
import { ResumeLibrary } from "./resumes";
import { BidWorkspace } from "./bids";
import { Earnings } from "./earnings";
export function BidderDetail({
  data,
  id,
}: {
  data: WorkspaceData;
  id: string;
}) {
  const person = data.profiles.find((p) => p.id === id)!;
  const bidder = data.bidders.find((b) => b.user_id === id)!;
  return (
    <>
      <Link
        className="mb-6 inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-primary"
        href="/users"
      >
        <ArrowLeft size={13} /> All people
      </Link>
      <PageHeading
        eyebrow="BIDDER PROFILE"
        title={person.display_name}
        description={`${person.email} · ${person.archived ? "Archived account" : "Active team member"}`}
      >
        <EditPerson person={person} bidder={bidder} />
      </PageHeading>
      <Tabs defaultValue="resumes">
        <TabsList className="mb-6">
          <TabsTrigger value="resumes">Resume profiles</TabsTrigger>
          <TabsTrigger value="bids">Bid activity</TabsTrigger>
          <TabsTrigger value="earnings">Earnings</TabsTrigger>
        </TabsList>
        <TabsContent value="resumes">
          <ResumeLibrary data={data} bidderId={id} embedded />
        </TabsContent>
        <TabsContent value="bids">
          <BidWorkspace data={data} bidderId={id} embedded />
        </TabsContent>
        <TabsContent value="earnings">
          <Earnings bidderId={id} embedded mailContext={{ role: data.profile.role, workspaceId: bidder.workspace_id }} />
        </TabsContent>
      </Tabs>
    </>
  );
}
