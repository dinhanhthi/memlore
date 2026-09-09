/** Coerce a Tauri `ipc::Response` / `Vec<u8>` payload to `Uint8Array`.
 *  WebKit may surface either a `Uint8Array` or a `number[]`. */
export function toUint8Array(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (ArrayBuffer.isView(raw)) {
    const view = raw
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[])
  throw new Error('read_basemap_range: unexpected payload type')
}
