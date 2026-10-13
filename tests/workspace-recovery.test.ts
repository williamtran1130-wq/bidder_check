import { existsSync } from "node:fs";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const modulePath = "../src/app/(workspace)/" + "error";
const Recovery = existsSync("src/app/(workspace)/error.tsx")
  ? (await import(modulePath)).default
  : () => null;

it("offers a retry and workspace navigation without rendering private server errors", () => {
  const retry = vi.fn();
  const props = { error: Object.assign(new Error("private SQL details"), { digest: "support-reference" }), retry };
  const markup = renderToStaticMarkup(createElement(Recovery, props));
  expect(markup).toMatch(/Try again/); expect(markup).toContain('href="/dashboard"');
  expect(markup).not.toContain("private SQL details");
  const tree = Recovery(props);
  function findRetry(node: ReactNode): (() => void) | undefined {
    if (!node || typeof node !== "object" || !("props" in node)) return;
    const element = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
    if (element.props.onClick) return element.props.onClick;
    return (Array.isArray(element.props.children) ? element.props.children : [element.props.children]).map(findRetry).find(Boolean);
  }
  findRetry(tree)?.(); expect(retry).toHaveBeenCalledOnce();
});
