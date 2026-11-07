import { pipeline, type FeatureExtractionPipeline, type ProgressInfo } from "@huggingface/transformers";

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  /** Returns one L2-normalised vector per input text. */
  embed(texts: string[]): Promise<number[][]>;
}

export const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

export type { ProgressInfo };

export interface LocalEmbedderOptions {
  /** Texts per forward pass. */
  batchSize?: number;
  /** Download and load progress of the model files (useful for a progress bar). */
  onProgress?: (info: ProgressInfo) => void;
}

/**
 * Sentence embeddings computed locally with transformers.js (onnxruntime in Node, WebAssembly in
 * a browser). No API key; the quantised model (~23 MB) is downloaded on first use and cached.
 */
export class LocalEmbedder implements Embedder {
  readonly dimensions = 384;
  private extractor: Promise<FeatureExtractionPipeline> | null = null;
  private readonly batchSize: number;
  private readonly onProgress: ((info: ProgressInfo) => void) | undefined;

  constructor(
    readonly model: string = DEFAULT_EMBEDDING_MODEL,
    options: LocalEmbedderOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 32;
    this.onProgress = options.onProgress;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.load();
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const output = await extractor(texts.slice(i, i + this.batchSize), { pooling: "mean", normalize: true });
      vectors.push(...(output.tolist() as number[][]));
    }
    return vectors;
  }

  /** Downloads and loads the model now instead of on the first `embed` call. */
  async warmUp(): Promise<void> {
    await this.load();
  }

  private load(): Promise<FeatureExtractionPipeline> {
    this.extractor ??= pipeline("feature-extraction", this.model, {
      dtype: "q8",
      ...(this.onProgress ? { progress_callback: this.onProgress } : {}),
    }).catch((error: unknown) => {
      // Let the next call retry, e.g. after a network error during the model download.
      this.extractor = null;
      throw error;
    });
    return this.extractor;
  }
}
