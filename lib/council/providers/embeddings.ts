import "server-only";

/**
 * Embedding interface (docs/ARCHITECTURE.md).
 * M0: interface only. OpenAIEmbeddings and OllamaEmbeddings arrive in M1.
 */
export interface Embedder {
  model: string;
  dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}
