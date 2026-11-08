/** Helper for large deterministic files (fast, seekless PRNG fill). */
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

/** Writes a deterministic pseudo-random file of `size` bytes. */
export async function seededBigFile(filePath: string, size: number): Promise<void> {
  const CHUNK = 1 << 20
  let state = 0x9e3779b9 >>> 0
  let written = 0
  const gen = new Readable({
    read(n): void {
      if (written >= size) {
        this.push(null)
        return
      }
      const take = Math.min(n, CHUNK, size - written)
      const buf = Buffer.allocUnsafe(take)
      for (let i = 0; i < take; i++) {
        state ^= state << 13
        state ^= state >>> 17
        state ^= state << 5
        buf[i] = state & 0xff
      }
      written += take
      this.push(buf)
    }
  })
  await pipeline(gen, createWriteStream(filePath))
}
