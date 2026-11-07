import { parse, type HTMLElement, type Node as HtmlNode, NodeType } from "node-html-parser";
import { extractText, getDocumentProxy } from "unpdf";
import type { DocumentFormat, Section } from "../types.js";

export class UnsupportedFormatError extends Error {
  constructor(name: string) {
    super(`Unsupported file type for "${name}". Use .md, .markdown, .html, .htm, .pdf or .txt.`);
    this.name = "UnsupportedFormatError";
  }
}

const EXTENSIONS: Record<string, DocumentFormat> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown",
  ".html": "html",
  ".htm": "html",
  ".pdf": "pdf",
  ".txt": "text",
};

/** The file extension with its dot, e.g. ".md"; "" when there is none. Works in Node and browsers. */
function extension(fileName: string): string {
  const base = fileName.slice(fileName.search(/[^/\\]*$/));
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

export function detectFormat(fileName: string): DocumentFormat {
  const format = EXTENSIONS[extension(fileName).toLowerCase()];
  if (!format) throw new UnsupportedFormatError(fileName);
  return format;
}

/** Turns raw file bytes into heading-aware sections. */
export async function loadDocument(fileName: string, data: Uint8Array): Promise<Section[]> {
  const format = detectFormat(fileName);
  switch (format) {
    case "pdf":
      return loadPdf(data);
    case "html":
      return loadHtml(decode(data));
    case "markdown":
      return loadMarkdown(decode(data));
    case "text":
      return nonEmpty([{ headings: [], page: null, text: normalizeWhitespace(decode(data)) }]);
  }
}

function decode(data: Uint8Array): string {
  return new TextDecoder("utf-8").decode(data);
}

/** Collapses runs of spaces but keeps paragraph breaks, which the chunker splits on. */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function nonEmpty(sections: Section[]): Section[] {
  return sections.filter((s) => s.text.length > 0);
}

/** Keeps the heading stack in sync when a heading of `level` (1-6) appears. */
function pushHeading(stack: { level: number; title: string }[], level: number, title: string): void {
  while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
  stack.push({ level, title });
}

// ---------------------------------------------------------------- Markdown

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function loadMarkdown(source: string): Section[] {
  const lines = source.replace(/\r\n?/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
  const stack: { level: number; title: string }[] = [];
  const sections: Section[] = [];
  let buffer: string[] = [];
  let fence: string | null = null;

  const flush = (): void => {
    const text = normalizeMarkdownWhitespace(buffer);
    if (text) sections.push({ headings: stack.map((h) => h.title), page: null, text });
    buffer = [];
  };

  for (const line of lines) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      buffer.push(line);
      continue;
    }
    const heading = fence === null ? ATX_HEADING.exec(line) : null;
    if (heading) {
      flush();
      pushHeading(stack, heading[1]!.length, cleanHeading(heading[2]!));
      continue;
    }
    buffer.push(fence === null ? stripInlineMarkdown(line) : line);
  }
  flush();
  return sections;
}

/** Like normalizeWhitespace, but keeps indentation inside fenced code blocks. */
function normalizeMarkdownWhitespace(lines: string[]): string {
  let fence: string | null = null;
  const out = lines.map((line) => {
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return line.trim();
    }
    return fence === null ? line.replace(/[ \t\f\v]+/g, " ").trim() : line.replace(/\s+$/, "");
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Heading text without inline HTML or components such as `<Badge text="new" />` (common in
 * VitePress docs). Tags inside backticks are kept, since they are usually what the section is about.
 */
export function cleanHeading(text: string): string {
  return stripInlineMarkdown(text)
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/<\/?[A-Za-z][^>]*>/g, "")))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Removes link/image/emphasis syntax so the stored text reads like prose. */
function stripInlineMarkdown(line: string): string {
  return line
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, "$1$2");
}

// -------------------------------------------------------------------- HTML

const SKIPPED_TAGS = new Set(["script", "style", "noscript", "template", "svg", "nav", "footer", "head"]);
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "main", "li", "ul", "ol", "pre", "blockquote", "table", "tr",
  "dt", "dd", "dl", "figure", "figcaption", "br", "hr",
]);

export function loadHtml(source: string): Section[] {
  const root = parse(source, { comment: false, blockTextElements: { pre: true } });
  const body = root.querySelector("main") ?? root.querySelector("article") ?? root.querySelector("body") ?? root;
  const title = root.querySelector("title")?.text.trim();

  const stack: { level: number; title: string }[] = [];
  if (title) stack.push({ level: 0, title });
  const sections: Section[] = [];
  let buffer = "";

  const flush = (): void => {
    const text = normalizeWhitespace(buffer);
    if (text) sections.push({ headings: stack.map((h) => h.title), page: null, text });
    buffer = "";
  };

  const walk = (node: HtmlNode): void => {
    if (node.nodeType === NodeType.TEXT_NODE) {
      buffer += decodeEntities(node.rawText);
      return;
    }
    if (node.nodeType !== NodeType.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    const tag = element.tagName?.toLowerCase() ?? "";
    if (SKIPPED_TAGS.has(tag)) return;

    const headingLevel = /^h([1-6])$/.exec(tag);
    if (headingLevel) {
      flush();
      const text = normalizeWhitespace(element.text).replace(/\n/g, " ");
      // An <h1> that only repeats the <title> should not add a second level.
      if (!(stack.length === 1 && stack[0]!.level === 0 && stack[0]!.title === text)) {
        pushHeading(stack, Number(headingLevel[1]), text);
      }
      return;
    }
    if (tag === "pre") {
      buffer += `\n\n${element.text}\n\n`;
      return;
    }
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) buffer += "\n\n";
    for (const child of element.childNodes) walk(child);
    if (isBlock) buffer += "\n\n";
  };

  walk(body);
  flush();
  return sections;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

// --------------------------------------------------------------------- PDF

export async function loadPdf(data: Uint8Array): Promise<Section[]> {
  // pdf.js takes ownership of the buffer, so hand it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: false });
  return nonEmpty(
    text.map((pageText, i) => ({ headings: [], page: i + 1, text: normalizeWhitespace(pageText) })),
  );
}
