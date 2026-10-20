# Known issues

Problems seen but not yet fixed. Each entry: what's seen, what's known, and
what to check next.

## Transcript words drift from the audio

*Seen 2026-10-19, in the recording details panel.*

The highlighted word (and the word row under the spectrogram) drifts away
from what's actually being said during playback.

**It's drift:** the gap grows over the recording (reported 2026-10-19).

**First case looked at** (rkey `3mxdy5d5mhc2o`, "Giden The Ninth"): an
uploaded MP3, not a browser recording. 789.1 s long, 48 kHz stereo,
**variable bitrate** (frames from 64 to 256 kbps, average 87 kbps), with a
Xing header. Transcribed by `whisper-large-v3-turbo`: 1,936 words, the last
ending at 785.2 s. So the transcript's timeline roughly agrees with the
file's length overall.

**Leading suspect: seeking in a VBR MP3.** Browsers can't seek precisely in
variable-bitrate MP3s: they estimate the byte position from the Xing
header's coarse table (100 points) or the average bitrate. After a seek,
`currentTime` reports the time asked for while the audio plays from
somewhere nearby, and the error tends to grow the further into the file
the seek goes. The panel seeks whenever a word or the spectrogram is
clicked. Untested; to check, play from the start *without clicking
anywhere*: if words stay in sync, seeking is the cause.

If so, possible fixes:
- Play through Web Audio from the decoded samples (the panel already
  decodes the file, though only at 16 kHz for the spectrogram), which seeks
  to the exact sample.
- Re-encode uploads in the browser before saving (to Opus, or constant
  bitrate), so stored files seek precisely everywhere.

Other things to establish:
- **Other recordings?** Recorded in the browser (WebM/Opus from
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
