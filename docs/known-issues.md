# Known issues

Problems seen: what's seen, what's known, and what to check next. Fixed
ones stay, marked fixed, with the cause, so they're recognized if they
come back.

## Transcript words drift from the audio: fixed

*Seen 2026-10-19 in the recording details panel; fixed 2026-10-21.*

The highlighted word, and the word row under the spectrogram, drifted
further from what was being said over a recording. The case looked at was
an uploaded 13-minute VBR MP3 (rkey `3mxdy5d5mhc2o`), whose transcript
timings matched the file's length.

**Cause:** browsers seek in VBR MP3 approximately, from the file's coarse
Xing table (100 entries), then report the time asked for: MP3 frames carry
no timestamps to correct with. gender-voice-visualization hit the same
thing on the same recording and measured it in Chromium: seeks landed
between -5.1 s and +0.5 s from where they said (its commit `7f076d1`).
The panel seeks whenever a word or the spectrogram is clicked.

**Fix** (`frontend/src/wav.ts`, as in that project): the panel decodes the
audio (now at 24 kHz, for the spectrogram and playback) and plays a mono
16-bit WAV of it, which seeks exactly. That project measured 20-53 ms
after the same fix, where it had been seconds. Files that are already
WAV play as they are. Recordings over 15 minutes aren't decoded, so
they still play their own file and can still drift.
