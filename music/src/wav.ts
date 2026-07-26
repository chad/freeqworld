// 16-bit PCM RIFF/WAVE encoder (no dependencies, works in Node and browsers).

import type { Audio } from './synth.ts'

export function encodeWav(audio: Audio, opts: { mono?: boolean } = {}): Uint8Array {
  const { sampleRate, left, right } = audio
  const frames = left.length
  const channels = opts.mono ? 1 : 2
  const bytesPerSample = 2
  const dataBytes = frames * channels * bytesPerSample
  const buf = new ArrayBuffer(44 + dataBytes)
  const dv = new DataView(buf)

  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  dv.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  dv.setUint32(16, 16, true) // PCM chunk size
  dv.setUint16(20, 1, true) // format = PCM
  dv.setUint16(22, channels, true)
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * channels * bytesPerSample, true)
  dv.setUint16(32, channels * bytesPerSample, true)
  dv.setUint16(34, 8 * bytesPerSample, true)
  ascii(36, 'data')
  dv.setUint32(40, dataBytes, true)

  let off = 44
  for (let i = 0; i < frames; i++) {
    if (channels === 1) {
      const v = Math.max(-1, Math.min(1, ((left[i] ?? 0) + (right[i] ?? 0)) / 2))
      dv.setInt16(off, Math.round(v * 32767), true)
      off += 2
      continue
    }
    for (const ch of [left, right]) {
      const v = Math.max(-1, Math.min(1, ch[i] ?? 0))
      dv.setInt16(off, Math.round(v * 32767), true)
      off += 2
    }
  }
  return new Uint8Array(buf)
}
