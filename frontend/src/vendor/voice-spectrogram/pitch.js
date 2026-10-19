// SPDX-License-Identifier: MIT
// (See LICENSE in this folder; the rest of the repository is AGPL-3.0.)

// Pitch estimation with YIN (de Cheveigné & Kawahara, 2002), cheap enough
// to run for every 10 ms of live audio. It's an approximation for display:
// the app's measurements use Praat's algorithm (voicemeasure), which can
// differ, especially near voicing boundaries.

export const PITCH_DEFAULTS = Object.freeze({
	minPitch: 75,     // Hz; Praat's default range
	maxPitch: 600,    // Hz
	threshold: .15,   // YIN's absolute threshold; lower is stricter
	silence: -50,     // dBFS; quieter frames are unvoiced
});

export class PitchTracker {
	constructor(sampleRate, options = {}) {
		let o = {...PITCH_DEFAULTS, ...options};
		this.sampleRate = sampleRate;
		this.minLag = Math.max(2, Math.floor(sampleRate / o.maxPitch));
		this.maxLag = Math.ceil(sampleRate / o.minPitch);
		this.window = this.maxLag;              // samples integrated per lag
		this.threshold = o.threshold;
		this.silence = o.silence;
		this.difference = new Float32Array(this.maxLag + 1);
	}

	// Samples needed either side of the centre.
	get reach() { return Math.ceil((this.window + this.maxLag) / 2); }

	// The pitch (Hz) around samples[center], or null if unvoiced.
	estimate(samples, center) {
		let {window, maxLag, minLag, difference: d} = this;
		let start = center - this.reach;
		if (start < 0 || start + window + maxLag > samples.length) return null;

		let energy = 0;
		for (let j = 0; j < window; j++) energy += samples[start + j] ** 2;
		if (10 * Math.log10(energy / window + 1e-20) < this.silence) return null;

		// Difference function and its cumulative mean normalised form.
		d[0] = 1;
		let sum = 0;
		for (let lag = 1; lag <= maxLag; lag++) {
			let value = 0;
			for (let j = 0; j < window; j++) {
				let delta = samples[start + j] - samples[start + j + lag];
				value += delta * delta;
			}
			sum += value;
			d[lag] = sum > 0 ? value * lag / sum : 1;
		}

		// The first dip below the threshold, followed to its minimum.
		let lag = -1;
		for (let tau = minLag; tau <= maxLag; tau++) {
			if (d[tau] < this.threshold) {
				while (tau + 1 <= maxLag && d[tau + 1] < d[tau]) tau++;
				lag = tau;
				break;
			}
		}
		if (lag < 0) return null;

		// Parabolic interpolation around the minimum.
		let shift = 0;
		if (lag > 1 && lag < maxLag) {
			let a = d[lag - 1], b = d[lag], c = d[lag + 1];
			let denominator = a - 2 * b + c;
			if (denominator > 0) shift = (a - c) / (2 * denominator);
		}
		return this.sampleRate / (lag + shift);
	}
}
