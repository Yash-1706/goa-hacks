import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Landing from "./Landing";

/** The public (GitHub Pages) copy has no app to open: it links to the demo page instead, and never to a private address. */
describe("landing links", () => {
  const pages = renderToStaticMarkup(createElement(Landing, { appUrl: "", repoUrl: "https://github.com/Yash-1706/goa-hacks", demoUrl: "./demo/" }));
  const mac = renderToStaticMarkup(createElement(Landing, { appUrl: "/app", repoUrl: "https://github.com/Yash-1706/goa-hacks", demoUrl: "https://example.org/demo/" }));

  it("Pages copy: no 'Open app' (there is no app to open there), a 'Watch the demo' link to ./demo/", () => {
    expect(pages).not.toContain("Open app");
    expect(pages).toMatch(/<a[^>]*href="\.\/demo\/"[^>]*>[^<]*Watch the demo/);
  });

  it("the Mac's own copy keeps 'Open app' (/app) and also links the demo", () => {
    expect(mac).toMatch(/<a[^>]*href="\/app"[^>]*>Open app/);
    expect(mac).toContain("Watch the demo");
  });
});
