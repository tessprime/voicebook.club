# Known issues

Problems seen but not yet fixed. Each entry: what's seen, what's known, and
what to check next.

## Transcript words drift from the audio

*Seen 2026-10-19, in the recording details panel.*

The highlighted word (and the word row under the spectrogram) drifts away
from what's actually being said during playback.

Not yet investigated. Things to establish first:

- **Drift or offset?** Does the gap grow over the recording (drift), or stay
  constant from the start (offset)? Note the times at a few points in a long
  recording.
- **Which recordings?** Recorded in the browser (WebM/Opus from
  `MediaRecorder`) or uploaded files; which transcription service and model
  (the record's `transcript.model`).
- **Which side is wrong?** Compare a word's `startMs` (from
  `GET /api/users/{did}/recordings/{rkey}`) with where the word is heard
  in a separate player, e.g. Audacity, on the same file.

Possible causes, unconfirmed:

- **The service's timestamps.** Whisper's word timings come from
  30-second windows and are known to slip over long audio; some servers
  realign them better than others.
- **Browser recordings' timing.** If `MediaRecorder`'s WebM timestamps
  don't match the audio's real length (we patch the duration with
  `fix-webm-duration`), the transcriber and the browser's player could
  measure time differently, which would grow over the recording.
- **The panel itself.** It plays the original file (`<audio>`) and draws the
  spectrogram from a copy decoded at 16 kHz; the highlighted word follows
  the `<audio>` element's `currentTime`, so it shouldn't drift, but this
  hasn't been checked.
