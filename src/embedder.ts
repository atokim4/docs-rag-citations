import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  /** Returns one L2-normalised vector per input text. */
  embed(texts: string[]): Promise<number[][]>;
}

export const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

/**
 * Sentence embeddings computed locally with transformers.js (ONNX runtime). No API key; the
 * quantised model (~23 MB) is downloaded on first use and cached.
 */
export class LocalEmbedder implements Embedder {
  readonly dimensions = 384;
  private extractor: Promise<FeatureExtractionPipeline> | null = null;

  constructor(
    readonly model: string = DEFAULT_EMBEDDING_MODEL,
    private readonly batchSize = 32,
  ) {}

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

  private load(): Promise<FeatureExtractionPipeline> {
    this.extractor ??= pipeline("feature-extraction", this.model, { dtype: "q8" }).catch((error: unknown) => {
      // Let the next call retry, e.g. after a network error during the model download.
      this.extractor = null;
      throw error;
    });
    return this.extractor;
  }
}
