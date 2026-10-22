// Playing decoded audio as WAV, so seeking is exact.
//
// Browsers seek compressed audio approximately: in a VBR MP3 by up to
// several seconds, from the file's coarse Xing table, while reporting the
// time asked for (MP3 frames carry no timestamps to correct with). A WAV
// seeks exactly, since every sample takes the same number of bytes. Same
// fix as gender-voice-visualization's player (its commit 7f076d1, where the
// error was measured at -5.1 s to +0.5 s on a 13-minute MP3).

/** A mono 16-bit WAV of an AudioBuffer (channels mixed down). Converts a block at a time, yielding between blocks. */
export async function audioBufferToWav(buffer: AudioBuffer): Promise<Blob> {
  const { length, sampleRate } = buffer
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))
  const view = new DataView(new ArrayBuffer(44 + length * 2))
  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true) // size of the fmt chunk
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // bytes per second
  view.setUint16(32, 2, true) // bytes per sample
  view.setUint16(34, 16, true) // bits per sample
  text(36, 'data')
  view.setUint32(40, length * 2, true)
  // WAV is little-endian, as are the platforms browsers run on.
  const samples = new Int16Array(view.buffer, 44, length)
  const block = 1 << 20 // ~44 s at 24 kHz
  for (let start = 0; start < length; start += block) {
    if (start) await new Promise((resolve) => setTimeout(resolve))
    const end = Math.min(start + block, length)
    for (let i = start; i < end; i++) {
      let sum = 0
      for (const channel of channels) sum += channel[i]
      const sample = Math.max(-1, Math.min(1, sum / channels.length))
      samples[i] = sample < 0 ? sample * 32768 : sample * 32767
    }
  }
  return new Blob([view], { type: 'audio/wav' })
}

/** Whether the bytes are already a WAV (which seeks exactly as it is), whatever the stated type. */
export async function isWav(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  const ascii = (from: number, to: number) => String.fromCharCode(...head.slice(from, to))
  return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE'
}
