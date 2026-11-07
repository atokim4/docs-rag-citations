import { describe, expect, it } from "vitest";
import {
  cleanHeading,
  detectFormat,
  loadDocument,
  loadHtml,
  loadMarkdown,
  UnsupportedFormatError,
} from "../src/ingest/loaders.js";
import { buildPdf, utf8 } from "./helpers.js";

describe("detectFormat", () => {
  it("maps extensions case-insensitively", () => {
    expect(detectFormat("Guide.MD")).toBe("markdown");
    expect(detectFormat("page.htm")).toBe("html");
    expect(detectFormat("manual.pdf")).toBe("pdf");
    expect(detectFormat("notes.txt")).toBe("text");
  });

  it("rejects unknown types", () => {
    expect(() => detectFormat("sheet.xlsx")).toThrow(UnsupportedFormatError);
  });

  it("reads only the last extension of the file name, without node:path", () => {
    expect(detectFormat("docs/v2.0/guide.backup.md")).toBe("markdown");
    expect(detectFormat("C:\\notes\\week.1.txt")).toBe("text");
    expect(() => detectFormat("docs.md/README")).toThrow(UnsupportedFormatError);
    expect(() => detectFormat(".md")).toThrow(UnsupportedFormatError);
  });
});

describe("loadMarkdown", () => {
  it("tracks the heading trail and resets it on a higher-level heading", () => {
    const sections = loadMarkdown(
      ["# Guide", "Intro text.", "## Install", "Run npm i.", "### Windows", "Use PowerShell.", "## Usage", "Call it."].join(
        "\n",
      ),
    );
    expect(sections.map((s) => [s.headings, s.text])).toEqual([
      [["Guide"], "Intro text."],
      [["Guide", "Install"], "Run npm i."],
      [["Guide", "Install", "Windows"], "Use PowerShell."],
      [["Guide", "Usage"], "Call it."],
    ]);
  });

  it("ignores '#' lines inside fenced code and keeps the code", () => {
    const sections = loadMarkdown(["# Config", "```sh", "# not a heading", "export A=1", "```"].join("\n"));
    expect(sections).toHaveLength(1);
    expect(sections[0]!.headings).toEqual(["Config"]);
    expect(sections[0]!.text).toContain("# not a heading");
  });

  it("strips front matter and link syntax", () => {
    const [section] = loadMarkdown("---\ntitle: x\n---\nSee the [docs](https://example.com) and **this**.");
    expect(section!.text).toBe("See the docs and this.");
  });
});

describe("loadHtml", () => {
  it("uses <title> as the root heading and skips scripts and nav", () => {
    const html = `<html><head><title>API Guide</title><script>var x = 1;</script></head>
      <body><nav>Home | Docs</nav><main><h1>API Guide</h1><p>Overview &amp; goals.</p>
      <h2>Auth</h2><p>Send a <code>Bearer</code> token.</p><ul><li>One</li><li>Two</li></ul></main></body></html>`;
    const sections = loadHtml(html);
    expect(sections.map((s) => s.headings)).toEqual([["API Guide"], ["API Guide", "Auth"]]);
    expect(sections[0]!.text).toBe("Overview & goals.");
    expect(sections[1]!.text).toBe("Send a Bearer token.\n\nOne\n\nTwo");
    expect(JSON.stringify(sections)).not.toContain("var x");
    expect(JSON.stringify(sections)).not.toContain("Home | Docs");
  });
});

describe("loadDocument (PDF)", () => {
  it("returns one section per page with its page number", async () => {
    const pdf = buildPdf(["Refund policy (v2)\nRefunds take 5 days.", "Shipping\nWe ship worldwide."]);
    const sections = await loadDocument("policy.pdf", pdf);
    expect(sections.map((s) => s.page)).toEqual([1, 2]);
    expect(sections[0]!.text).toContain("Refunds take 5 days.");
    expect(sections[1]!.text).toContain("We ship worldwide.");
  });

  it("reads plain text files as a single section", async () => {
    const sections = await loadDocument("a.txt", utf8("\uFEFFline one\r\n\r\n\r\nline two"));
    expect(sections).toEqual([{ headings: [], page: null, text: "line one\n\nline two" }]);
  });
});

describe("cleanHeading", () => {
  it("drops inline HTML and components but keeps tags in code spans", () => {
    expect(cleanHeading('<Badge type="info" text="optional" /> maxSize: `number`')).toBe("maxSize: `number`");
    expect(cleanHeading("Using `<Suspense>` with **streaming**")).toBe("Using `<Suspense>` with streaming");
  });
});
