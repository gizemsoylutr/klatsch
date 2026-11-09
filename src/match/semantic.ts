/**
 * Semantic matching, for a relay whose operator turned it on (`KLATSCH_SEMANTIC=1`): a looking sip and a solved
 * one can match on what they say, not only on shared tags. It is off by default, and the package does not depend
 * on the model's library (about 470 MB): an operator installs it next to the relay.
 *
 * The model runs in the relay's own process. It only turns one approved summary into numbers; its output goes
 * nowhere but a comparison, so it cannot be told to do anything and nothing it reads reaches an agent.
 */
export interface Embedder {
  /** Names the model, so vectors of another one are never compared. */
  model: string;
  embed(text: string): Promise<Float32Array>;
}

export const SEMANTIC_MODEL = 'Xenova/all-MiniLM-L6-v2';
/**
 * Chosen on a small set of problem and fix pairs with this model (2026-11-06): 7 of 8 related pairs scored 0.38 to
 * 0.59, the eighth 0.15, and 10 unrelated pairs at most 0.18. Above the noise: a missed match costs less than a
 * stranger's note on the wrong problem.
 */
export const SEMANTIC_THRESHOLD = 0.35;
export const SEMANTIC_MAX_MATCHES = 3;

/** Vectors are normalised by the model, so this is their cosine. Different lengths never compare. */
export function similarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

export const toBlob = (vector: Float32Array): Uint8Array => new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
export const fromBlob = (blob: Uint8Array): Float32Array => new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer);

/**
 * The model behind `KLATSCH_SEMANTIC=1`, loaded at the first use, or undefined when its library is not installed.
 * The model file is fetched once into the data dir (`cacheDir`), the one place the relay writes.
 */
export async function loadEmbedder(cacheDir: string): Promise<Embedder | undefined> {
  // A variable, so that neither the compiler nor a bundler looks for this optional library.
  const library = '@huggingface/transformers';
  let transformers: any;
  try {
    transformers = await import(library);
  } catch {
    return undefined;
  }
  transformers.env.cacheDir = cacheDir;
  let extractor: Promise<(text: string, options: object) => Promise<{ data: Float32Array }>> | undefined;
  return {
    model: SEMANTIC_MODEL,
    async embed(text) {
      extractor ??= transformers.pipeline('feature-extraction', SEMANTIC_MODEL, { dtype: 'q8' });
      const run = await extractor!;
      return Float32Array.from((await run(text, { pooling: 'mean', normalize: true })).data);
    },
  };
}
