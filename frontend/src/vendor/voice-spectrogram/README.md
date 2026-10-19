# voice-spectrogram (vendored)

The `<voice-spectrogram>` element from the gender voice visualization app
(`components/voice-spectrogram`, MIT, see `LICENSE`), copied at commit
`7118a68`. Only the files `<voice-spectrogram>` needs are here.

Local change, in `voice-spectrogram.js` (marked "voicebook patch"): its
styles are adopted as a constructed stylesheet instead of a `<style>` element
in the shadow root, which Voicebook's Content-Security-Policy (`style-src
'self'`) would block. Worth upstreaming, then this copy can be replaced with
the original.

`voice-spectrogram.d.ts` declares the parts Voicebook uses; see the
upstream README for the full API.
