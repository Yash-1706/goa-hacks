import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Landing from "./Landing";

/** The launch video in the hero: muted, looping, inline on phones, with the poster as its fallback. */
describe("landing hero video", () => {
  const html = renderToStaticMarkup(createElement(Landing, { appUrl: "/app", repoUrl: "https://github.com/Yash-1706/goa-hacks" }));
  const video = html.match(/<video[^>]*>[\s\S]*?<\/video>/)?.[0] ?? "";

  it("is muted, loops and plays inline (autoplay is allowed only when muted)", () => {
    expect(video).toMatch(/\smuted(=""|\s|>)/);
    expect(video).toMatch(/\sloop(=""|\s|>)/);
    expect(video).toMatch(/\splaysinline(=""|\s|>)/i);
    expect(video).toMatch(/\sautoplay(=""|\s|>)/i);
  });

  it("uses the landscape launch video, relative to the page base, with its poster as fallback", () => {
    expect(video).toMatch(/poster="[^"]*media\/synapse-launch-landscape\.jpg"/);
    expect(video).toMatch(/src="[^"]*media\/synapse-launch-landscape\.mp4"/);
    expect(video).toContain('<img src="');
  });
});
