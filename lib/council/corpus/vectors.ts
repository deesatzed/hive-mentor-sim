import "server-only";

/** Embeddings are stored as raw little-endian Float32 bytes (docs/DATA_MODEL.md). */
export function toBytes(v: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(v.length * 4));
  const dv = new DataView(out.buffer);
  v.forEach((x, i) => dv.setFloat32(i * 4, x, true));
  return out;
}

export function fromBytes(b: Uint8Array): Float32Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = new Float32Array(b.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

export function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/** Runs `fn` over items with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
