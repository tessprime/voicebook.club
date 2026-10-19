// Types for the parts of <voice-spectrogram> Voicebook uses (see README.md).

export type Interval = { start: number; end: number; label: string; kind?: string }

export type SeekEvent = CustomEvent<{ time: number; segment: (Interval & { tier: 'word' | 'phone' }) | null }>

export declare class VoiceSpectrogram extends HTMLElement {
  audio: AudioBuffer | { samples: Float32Array; sampleRate: number } | null
  words: Interval[]
  phones: Interval[]
  currentTime: number | null
  readonly duration: number
  setView(start: number, end: number | null): void
}

declare global {
  interface HTMLElementTagNameMap {
    'voice-spectrogram': VoiceSpectrogram
  }
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'voice-spectrogram': React.DetailedHTMLProps<React.HTMLAttributes<VoiceSpectrogram>, VoiceSpectrogram> & {
        colormap?: string
        'max-frequency'?: number
        'min-frequency'?: number
        'frequency-scale'?: 'linear' | 'log'
        'view-duration'?: number
        'show-pitch'?: 'on' | 'off'
      }
    }
  }
}
