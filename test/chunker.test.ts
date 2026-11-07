import { describe, expect, it } from "vitest";
import { chunkSections, chunkText, embeddingInput } from "../src/ingest/chunker.js";

const words = (n: number, prefix = "w"): string => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

describe("chunkText", () => {
  it("keeps short text as one chunk", () => {
    expect(chunkText("Hello there.\n\nSecond paragraph.", { maxWords: 50, overlapWords: 5 })).toEqual([
      "Hello there.\n\nSecond paragraph.",
    ]);
  });

  it("never exceeds maxWords and overlaps neighbouring chunks", () => {
    const text = Array.from({ length: 12 }, (_, i) => words(9, `p${i}_`)).join("\n\n");
    const chunks = chunkText(text, { maxWords: 30, overlapWords: 10 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(wordCount(chunk)).toBeLessThanOrEqual(30);
    for (let i = 1; i < chunks.length; i++) {
      const lastParagraphOfPrevious = chunks[i - 1]!.split("\n\n").at(-1)!;
      expect(chunks[i]!.startsWith(lastParagraphOfPrevious)).toBe(true);
    }
    // Every paragraph survives somewhere.
    for (let i = 0; i < 12; i++) expect(chunks.some((c) => c.includes(`p${i}_8`))).toBe(true);
  });

  it("splits an oversized paragraph by sentences, then by words", () => {
    const longSentence = `${words(70)}.`;
    const text = `Short one. ${longSentence} Another short one.`;
    const chunks = chunkText(text, { maxWords: 25, overlapWords: 0 });
    for (const chunk of chunks) expect(wordCount(chunk)).toBeLessThanOrEqual(25);
    expect(chunks.join(" ").split(/\s+/)).toEqual(text.split(/\s+/));
  });

  it("carries raw trailing words when the last unit is longer than the overlap", () => {
    const chunks = chunkText(`${words(20, "a")}\n\n${words(20, "b")}`, { maxWords: 25, overlapWords: 3 });
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.startsWith("a17 a18 a19")).toBe(true);
  });
});

describe("chunkSections", () => {
  it("does not merge sections and numbers chunks across the document", () => {
    const chunks = chunkSections(
      [
        { headings: ["A"], page: 1, text: words(40) },
        { headings: ["B"], page: 2, text: "tiny" },
      ],
      { maxWords: 30, overlapWords: 5 },
    );
    expect(chunks.map((c) => [c.index, c.headings[0], c.page])).toEqual([
      [0, "A", 1],
      [1, "A", 1],
      [2, "B", 2],
    ]);
  });

  it("validates options", () => {
    expect(() => chunkSections([], { maxWords: 10, overlapWords: 10 })).toThrow(RangeError);
  });
});

describe("embeddingInput", () => {
  it("prefixes the heading trail", () => {
    expect(embeddingInput({ headings: ["Guide", "Install"], content: "Run it." })).toBe("Guide > Install\nRun it.");
    expect(embeddingInput({ headings: [], content: "Run it." })).toBe("Run it.");
  });
});
