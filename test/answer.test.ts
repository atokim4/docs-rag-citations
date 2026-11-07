import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnswerError,
  ClaudeAnswerer,
  ExtractiveAnswerer,
  REFUSAL,
  isRefusal,
  resolveCitations,
  type Answerer,
  type DraftAnswer,
} from "../src/answer/index.js";
import { blocksOf, stem, terms } from "../src/answer/extractive.js";
import { buildUserMessage, SYSTEM_PROMPT, type MessagesClient } from "../src/answer/claude.js";
import { DocsLibrary } from "../src/library.js";
import type { Source } from "../src/types.js";
import { HashingEmbedder, utf8 } from "./helpers.js";

const source = (n: number, content: string, headings: string[] = ["Guide"]): Source => ({
  n,
  chunkId: n,
  documentName: `doc-${n}.md`,
  headings,
  page: null,
  content,
  similarity: 0.6,
});

describe("resolveCitations", () => {
  it("keeps valid markers in order of first use and drops the rest", () => {
    const { text, cited } = resolveCitations("Use port 8787 [2]. It also needs a key [1, 2] [9].", 2);
    expect(cited).toEqual([2, 1]);
    expect(text).toBe("Use port 8787 [2]. It also needs a key [1][2].");
  });

  it("returns no citations for plain text", () => {
    expect(resolveCitations("No markers here.", 3)).toEqual({ text: "No markers here.", cited: [] });
  });
});

describe("isRefusal", () => {
  it("accepts the refusal sentence with wording drift", () => {
    expect(isRefusal(REFUSAL)).toBe(true);
    expect(isRefusal("I don’t know based on the documents provided.")).toBe(true);
    expect(isRefusal("I do not know.")).toBe(true);
    expect(isRefusal("The default port is 3000 [1].")).toBe(false);
  });
});

describe("terms and stem", () => {
  it("splits camelCase, drops stop words and stems", () => {
    expect(terms("How do I use setCookie on routes?")).toEqual(["set", "cooki", "rout"]);
    expect(stem("routing")).toBe(stem("routes"));
    expect(stem("class")).toBe("class");
  });
});

describe("blocksOf", () => {
  it("separates prose from fenced code and keeps indentation", () => {
    const blocks = blocksOf("Install it like this:\n\n```ts\nif (x) {\n  run()\n}\n```\n\nThen start.");
    expect(blocks).toEqual([
      { text: "Install it like this:", code: false },
      { text: "if (x) {\n  run()\n}", code: true },
      { text: "Then start.", code: false },
    ]);
  });

  it("treats a chunk that starts inside a fenced block as code up to the closing fence", () => {
    const blocks = blocksOf("const a = 1;\nreturn a;\n```\n\nThat returns one.");
    expect(blocks).toEqual([
      { text: "const a = 1;\nreturn a;", code: true },
      { text: "That returns one.", code: false },
    ]);
  });
});

describe("ExtractiveAnswerer", () => {
  const answerer = new ExtractiveAnswerer();

  it("quotes the passage that covers the question, with its citation", async () => {
    const sources = [
      source(1, "Hono runs on many runtimes."),
      source(2, "The default port number is 8787. You can change the port with the port option."),
    ];
    const { text } = await answerer.answer("How do I change the port number?", sources);
    expect(text).toBe("The default port number is 8787. You can change the port with the port option. [2]");
  });

  it("keeps a code sample together with the line that introduces it", async () => {
    const sources = [source(1, "Enable CORS for the API like this:\n\n```ts\napp.use('/api/*', cors())\n```")];
    const { text } = await answerer.answer("How do I enable CORS?", sources);
    expect(text).toBe("Enable CORS for the API like this:\n\n```\napp.use('/api/*', cors())\n```\n[1]");
  });

  it("refuses when no passage covers enough of the question", async () => {
    const sources = [source(1, "Hono is a small web framework.")];
    expect((await answerer.answer("How do I configure a Kafka consumer group?", sources)).text).toBe(REFUSAL);
    expect((await answerer.answer("???", sources)).text).toBe(REFUSAL);
    expect((await answerer.answer("What is Hono?", [])).text).toBe(REFUSAL);
  });

  it("is deterministic", async () => {
    const sources = [source(1, "Cookies are set with setCookie. Read them with getCookie."), source(2, "Set a cookie.")];
    const first = await answerer.answer("How do I set a cookie?", sources);
    expect(await answerer.answer("How do I set a cookie?", sources)).toEqual(first);
  });
});

describe("ClaudeAnswerer", () => {
  const message = (overrides: Partial<Anthropic.Message>): Anthropic.Message =>
    ({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [{ type: "text", text: "The port is 8787 [1].", citations: null }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
      ...overrides,
    }) as Anthropic.Message;

  const fakeClient = (create: (...args: unknown[]) => Promise<Anthropic.Message>): MessagesClient =>
    ({ messages: { create } }) as unknown as MessagesClient;

  it("sends the sources and the grounding prompt to the configured model", async () => {
    const create = vi.fn(() => Promise.resolve(message({})));
    const answerer = new ClaudeAnswerer({ model: "claude-haiku-5-5", client: fakeClient(create) });
    const result = await answerer.answer("Which port?", [source(1, "Port 8787.")]);

    expect(result.text).toBe("The port is 8787 [1].");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-haiku-5-5",
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserMessage("Which port?", [source(1, "Port 8787.")]) }],
      }),
    );
  });

  it("turns a safety refusal into the standard refusal", async () => {
    const answerer = new ClaudeAnswerer({ client: fakeClient(() => Promise.resolve(message({ stop_reason: "refusal", content: [] }))) });
    expect((await answerer.answer("q", [source(1, "x")])).text).toBe(REFUSAL);
  });

  it("raises AnswerError for API failures and empty replies", async () => {
    const failing = new ClaudeAnswerer({
      client: fakeClient(() => Promise.reject(new Anthropic.APIConnectionError({ message: "offline" }))),
    });
    await expect(failing.answer("q", [source(1, "x")])).rejects.toThrow("Could not reach the Anthropic API");

    const empty = new ClaudeAnswerer({ client: fakeClient(() => Promise.resolve(message({ content: [] }))) });
    await expect(empty.answer("q", [source(1, "x")])).rejects.toBeInstanceOf(AnswerError);
  });

  it("marks source text as data in the user message", () => {
    const text = buildUserMessage("Q?", [source(1, "Body", ['Say "hi"'])]);
    expect(text).toBe('<source n="1" from="doc-1.md > Say &quot;hi&quot;">\nBody\n</source>\n\nQuestion: Q?');
  });
});

describe("DocsLibrary.ask", () => {
  let library: DocsLibrary | undefined;
  afterEach(async () => {
    await library?.close();
    library = undefined;
  });

  class ScriptedAnswerer implements Answerer {
    readonly engine = "claude";
    readonly model = "scripted";
    readonly calls: string[] = [];
    constructor(private readonly reply: string) {}
    answer(question: string): Promise<DraftAnswer> {
      this.calls.push(question);
      return Promise.resolve({ text: this.reply });
    }
  }

  const open = async (answerer: Answerer): Promise<DocsLibrary> => {
    library = await DocsLibrary.open({ embedder: new HashingEmbedder(), answerer });
    await library.ingest("guide.md", utf8("# Guide\n\n## Port\n\nThe server listens on port 8787 by default."));
    return library;
  };

  it("returns the answer, the cited sources and all retrieved sources", async () => {
    const lib = await open(new ScriptedAnswerer("It listens on port 8787 [1]."));
    const result = await lib.ask("  Which port does the server listen on?  ");
    expect(result).toMatchObject({
      question: "Which port does the server listen on?",
      answer: "It listens on port 8787 [1].",
      refused: false,
      cited: [1],
      engine: "claude",
      model: "scripted",
    });
    expect(result.sources[0]).toMatchObject({ n: 1, documentName: "guide.md", headings: ["Guide", "Port"] });
  });

  it("refuses without calling the answer step when nothing is similar enough", async () => {
    const answerer = new ScriptedAnswerer("anything [1]");
    const lib = await open(answerer);
    const result = await lib.ask("Kafka consumer group rebalancing", { minSimilarity: 0.99 });
    expect(result).toMatchObject({ answer: REFUSAL, refused: true, cited: [] });
    expect(answerer.calls).toEqual([]);
  });

  it("treats an answer without valid citations as a refusal", async () => {
    const lib = await open(new ScriptedAnswerer("Port 8787 [7]."));
    expect(await lib.ask("Which port does the server listen on?")).toMatchObject({ refused: true, cited: [] });
  });
});

describe("resolveCitations with code", () => {
  it("leaves indentation inside fenced code untouched", () => {
    const answer = "Like this:\n\n```\nif (x) {\n    run()  ;\n}\n```\n[1]";
    expect(resolveCitations(answer, 1).text).toBe(answer);
  });
});
