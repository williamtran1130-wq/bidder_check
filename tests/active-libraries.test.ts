import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ResumeLibrary } from "../src/components/resumes";
import { CandidateProfileLibrary } from "../src/components/profiles";
import { ResumeSelector } from "../src/components/resume-selector";
import { buildResumeOptions } from "../src/lib/resume-options";
import { fixture } from "./preview/sample-data";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/app/(workspace)/actions", () => ({}));
vi.hoisted(() => { vi.stubGlobal("window", { location: { search: "" } }); });

describe("active libraries", () => {
  it.each(["account", "membership"])("hides resume cards belonging to an archived %s", (ancestor) => {
    const data = structuredClone(fixture);
    if (ancestor === "account") data.profiles.find((p) => p.id === "bidder-0")!.archived = true;
    else data.bidders[0].archived = true;
    const html = renderToStaticMarkup(createElement(ResumeLibrary, { data }));
    expect(html).not.toContain("bidder0@example.test");
    expect(html).toContain("bidder1@example.test");
  });
  it("hides candidate cards belonging to an archived workspace owner", () => {
    const data = structuredClone(fixture);
    data.profile.archived = true;
    const html = renderToStaticMarkup(createElement(CandidateProfileLibrary, { data }));
    expect(html).not.toContain("ENG-01");
  });
  it("does not pin an archived selection in the resume picker", () => {
    const data = structuredClone(fixture);
    data.resumes[0].archived = true;
    const html = renderToStaticMarkup(createElement(ResumeSelector, { options: [...buildResumeOptions(data).values()], value: "resume-0", onChange() {} }));
    expect(html).toContain("All resumes");
    expect(html).not.toContain("bidder0@example.test");
  });
});
