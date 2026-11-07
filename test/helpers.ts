import type { Embedder } from "../src/embedder.js";

/**
 * Builds a minimal valid PDF with one page per string (Helvetica, one line per `\n`).
 * Generated at test time so the repo carries no binary fixtures.
 */
export function buildPdf(pages: string[]): Uint8Array {
  const escape = (s: string): string => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, i) => {
    const lines = text.split("\n").map((line) => `(${escape(line)}) Tj T*`).join(" ");
    const stream = `BT /F1 12 Tf 14 TL 72 720 Td ${lines} ET`;
    objects[pageIds[i]!] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`;
    objects[pageIds[i]! + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

/**
 * Deterministic bag-of-words embedder for fast store tests: words hash into buckets, so
 * texts that share words get similar vectors. Not a semantic model.
 */
export class HashingEmbedder implements Embedder {
  readonly model = "test/hashing";
  constructor(readonly dimensions = 64) {}

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.vector(text)));
  }

  private vector(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let h = 2166136261;
      for (const ch of word) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
      v[(h >>> 0) % this.dimensions]! += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
