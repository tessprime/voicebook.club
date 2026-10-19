// SPDX-License-Identifier: MIT
// (See LICENSE in this folder; the rest of the repository is AGPL-3.0.)

// Spectrogram computation and painting, shared by <voice-spectrogram> (a
// whole recording) and the live view. Nothing here touches the DOM except
// renderFrequencyAxis(), so it also works in a worker and loads safely
// during server-side rendering.
//
// The defaults follow Praat's spectrogram: a Gaussian window of effective
// length 5 ms (a "broadband" spectrogram, which shows formants as dark
// bands rather than resolving individual harmonics), up to 5 kHz, 70 dB of
// dynamic range and +6 dB/octave pre-emphasis.

export const DEFAULTS = Object.freeze({
	windowLength: 0.005,  // s, effective; the window spans twice this
	timeStep: 0.002,      // s between columns (raised for long recordings)
	maxFrequency: 5000,   // Hz
	dynamicRange: 70,     // dB below the loudest point that still shows
	preEmphasis: 6,       // dB per octave above 50 Hz
	maxColumns: 8000,     // longer recordings get a larger time step
});

// In-place radix-2 FFT of (re, im), whose length must be a power of two.
// Tables are cached per size.
const fftTables = new Map();
function fftTablesFor(n) {
	if (!fftTables.has(n)) {
		let bits = Math.log2(n);
		let reverse = new Uint32Array(n);
		for (let i = 0; i < n; i++) {
			let r = 0;
			for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
			reverse[i] = r;
		}
		let cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
		for (let i = 0; i < n / 2; i++) {
			cos[i] = Math.cos(-2 * Math.PI * i / n);
			sin[i] = Math.sin(-2 * Math.PI * i / n);
		}
		fftTables.set(n, {reverse, cos, sin});
	}
	return fftTables.get(n);
}

export function fft(re, im) {
	let n = re.length;
	let {reverse, cos, sin} = fftTablesFor(n);
	for (let i = 0; i < n; i++) {
		let j = reverse[i];
		if (j > i) {
			[re[i], re[j]] = [re[j], re[i]];
			[im[i], im[j]] = [im[j], im[i]];
		}
	}
	for (let size = 2; size <= n; size *= 2) {
		let half = size / 2, step = n / size;
		for (let start = 0; start < n; start += size) {
			for (let k = 0; k < half; k++) {
				let a = start + k, b = a + half;
				let wr = cos[k * step], wi = sin[k * step];
				let tr = re[b] * wr - im[b] * wi;
				let ti = re[b] * wi + im[b] * wr;
				re[b] = re[a] - tr; im[b] = im[a] - ti;
				re[a] += tr;        im[a] += ti;
			}
		}
	}
}

// Computes one spectrogram column at a time: the power spectrum, in dB,
// of the window centred on a sample, from 0 Hz to maxFrequency.
export class SpectrumAnalyzer {
	constructor(sampleRate, options = {}) {
		let o = {...DEFAULTS, ...options};
		this.sampleRate = sampleRate;
		this.maxFrequency = Math.min(o.maxFrequency, sampleRate / 2);

		// Praat's Gaussian window: physical length twice the effective one.
		let length = Math.max(4, Math.round(2 * o.windowLength * sampleRate));
		this.window = new Float32Array(length);
		let edge = Math.exp(-12);
		for (let i = 0; i < length; i++) {
			let x = (i + .5) / length - .5;
			this.window[i] = (Math.exp(-48 * x * x) - edge) / (1 - edge);
		}
		// Zero-padded to twice the next power of two, for a smoother
		// frequency axis.
		this.fftSize = 2 ** (Math.ceil(Math.log2(length)) + 1);
		this.binHz = sampleRate / this.fftSize;
		this.bins = Math.floor(this.maxFrequency / this.binHz) + 1;

		this.emphasis = new Float32Array(this.bins);
		for (let k = 0; k < this.bins; k++) {
			let f = k * this.binHz;
			this.emphasis[k] = f > 50 ? o.preEmphasis * Math.log2(f / 50) : 0;
		}
		this.re = new Float64Array(this.fftSize);
		this.im = new Float64Array(this.fftSize);
	}

	// Writes the column centred on samples[center] into out (bins values).
	column(samples, center, out) {
		let {window, re, im} = this;
		let first = center - Math.floor(window.length / 2);
		re.fill(0);
		im.fill(0);
		for (let i = 0; i < window.length; i++) {
			let s = first + i;
			if (s >= 0 && s < samples.length) re[i] = samples[s] * window[i];
		}
		fft(re, im);
		for (let k = 0; k < this.bins; k++) {
			let power = re[k] * re[k] + im[k] * im[k];
			out[k] = 10 * Math.log10(power + 1e-20) + this.emphasis[k];
		}
		return out;
	}
}

// The spectrogram of a whole recording (mono samples).
// Returns {data, columns, bins, timeStep, binHz, maxFrequency, duration,
// maxDb}, with data holding columns × bins dB values, column by column;
// column i is centred at (i + .5) * timeStep.
export function computeSpectrogram(samples, sampleRate, options = {}) {
	let o = {...DEFAULTS, ...options};
	let duration = samples.length / sampleRate;
	let timeStep = Math.max(o.timeStep, duration / o.maxColumns);
	let columns = Math.max(1, Math.floor(duration / timeStep));
	let analyzer = new SpectrumAnalyzer(sampleRate, o);
	let data = new Float32Array(columns * analyzer.bins);
	let maxDb = -Infinity;
	for (let i = 0; i < columns; i++) {
		let column = data.subarray(i * analyzer.bins, (i + 1) * analyzer.bins);
		analyzer.column(samples, Math.round((i + .5) * timeStep * sampleRate), column);
		for (let v of column) if (v > maxDb) maxDb = v;
	}
	return {
		data, columns, bins: analyzer.bins, timeStep, duration, maxDb,
		binHz: analyzer.binHz, maxFrequency: analyzer.maxFrequency,
	};
}

// Colour maps as 256 RGB entries, interpolated from a few stops; value 0 is
// silence and 1 the loudest. "magma" suits dark pages, "gray" (Praat's
// black on white) light ones.
const COLORMAP_STOPS = {
	magma: ['#000004', '#1c1044', '#4f127b', '#812581', '#b5367a', '#e55964', '#fb8761', '#fec287', '#fcfdbf'],
	viridis: ['#440154', '#472c7a', '#3b518b', '#2c718e', '#21908d', '#27ad81', '#5cc863', '#aadc32', '#fde725'],
	gray: ['#ffffff', '#000000'],
};
const colormapCache = new Map();
export function colormap(name) {
	if (!colormapCache.has(name)) {
		let stops = (COLORMAP_STOPS[name] || COLORMAP_STOPS.magma).map(hex =>
			[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));
		let table = new Uint8ClampedArray(256 * 3);
		for (let i = 0; i < 256; i++) {
			let position = i / 255 * (stops.length - 1);
			let low = Math.min(Math.floor(position), stops.length - 2);
			let t = position - low;
			for (let c = 0; c < 3; c++) {
				table[i * 3 + c] = stops[low][c] + (stops[low + 1][c] - stops[low][c]) * t;
			}
		}
		colormapCache.set(name, table);
	}
	return colormapCache.get(name);
}

// A frequency axis: {min, max, log}, in Hz. On a log axis, equal ratios get
// equal height (an octave is an octave), which gives the low frequencies
// where pitch and its first harmonics are much more room. A log axis can't
// start at 0, so min is at least MIN_LOG_FREQUENCY there.
export const MIN_LOG_FREQUENCY = 20;
export const DEFAULT_LOG_MIN = 75;   // Praat's lowest default pitch

export function frequencyScale(min, max, log) {
	min = log ? Math.max(MIN_LOG_FREQUENCY, min > 0 ? min : DEFAULT_LOG_MIN) : Math.max(0, min || 0);
	return {min: Math.min(min, max * .9), max, log: !!log};
}

// Where a frequency falls on the axis, from 0 (bottom) to 1 (top).
export function frequencyFraction(frequency, scale) {
	if (scale.log) return Math.log(frequency / scale.min) / Math.log(scale.max / scale.min);
	return (frequency - scale.min) / (scale.max - scale.min);
}

export function frequencyAt(fraction, scale) {
	if (scale.log) return scale.min * (scale.max / scale.min) ** fraction;
	return scale.min + fraction * (scale.max - scale.min);
}

// Images are painted for the axis, at this many rows (the canvas scales
// them to the element's height).
export const IMAGE_ROWS = 400;

// For each image row, top first, the fractional spectrum bin it shows, or
// NaN above the last bin.
export function rowBins(scale, binHz, bins, rows = IMAGE_ROWS) {
	let map = new Float32Array(rows);
	for (let r = 0; r < rows; r++) {
		let bin = frequencyAt(1 - (r + .5) / rows, scale) / binHz;
		map[r] = bin <= bins - 1 ? bin : NaN;
	}
	return map;
}

// Paint one spectrum (bins dB values) as column x of an RGBA image of the
// given width, one row per entry of rows (from rowBins()), interpolating
// between bins: on a log axis the lowest bins span many rows.
export function paintColumn(pixels, width, x, spectrum, rows, maxDb, dynamicRange, table) {
	let floor = maxDb - dynamicRange;
	for (let r = 0; r < rows.length; r++) {
		let p = (r * width + x) * 4, bin = rows[r];
		if (isNaN(bin)) {
			pixels[p + 3] = 0;
			continue;
		}
		let low = Math.floor(bin), t = bin - low;
		let db = t ? spectrum[low] * (1 - t) + spectrum[low + 1] * t : spectrum[low];
		let index = Math.round(Math.min(1, Math.max(0, (db - floor) / dynamicRange)) * 255) * 3;
		pixels[p] = table[index];
		pixels[p + 1] = table[index + 1];
		pixels[p + 2] = table[index + 2];
		pixels[p + 3] = 255;
	}
}

// Audio for analyses that only need low frequencies (pitch, narrowband
// spectrograms) is decimated to about this rate, which makes them cheaper.
export const ANALYSIS_RATE = 16000;

// Low-pass (two biquads) and keep every factor-th sample.
export class Decimator {
	constructor(rate, factor) {
		this.factor = factor;
		this.phase = 0;
		let w = 2 * Math.PI * .45 * rate / factor / rate, alpha = Math.sin(w) / (2 * Math.SQRT1_2);
		let a0 = 1 + alpha;
		this.b = [(1 - Math.cos(w)) / 2 / a0, (1 - Math.cos(w)) / a0, (1 - Math.cos(w)) / 2 / a0];
		this.a = [-2 * Math.cos(w) / a0, (1 - alpha) / a0];
		this.state = [[0, 0, 0, 0], [0, 0, 0, 0]];  // x1, x2, y1, y2 per stage
	}

	process(input) {
		if (this.factor == 1) return input;
		let out = new Float32Array(Math.ceil((input.length + this.phase) / this.factor));
		let count = 0;
		for (let x of input) {
			for (let s of this.state) {
				let y = this.b[0] * x + this.b[1] * s[0] + this.b[2] * s[1] - this.a[0] * s[2] - this.a[1] * s[3];
				s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y;
				x = y;
			}
			if (this.factor == 1 || this.phase == 0) out[count++] = x;
			this.phase = (this.phase + 1) % this.factor;
		}
		return out.subarray(0, count);
	}
}

// Whole samples decimated to about ANALYSIS_RATE: {samples, sampleRate}.
export function decimate(samples, sampleRate) {
	let factor = Math.max(1, Math.round(sampleRate / ANALYSIS_RATE));
	return {samples: new Decimator(sampleRate, factor).process(samples), sampleRate: sampleRate / factor};
}

// A pitch track ([{time, hz}], hz null when unvoiced) at a fixed step.
export function computePitchTrack(samples, sampleRate, tracker, timeStep = .01) {
	let track = [];
	for (let t = timeStep / 2; t < samples.length / sampleRate; t += timeStep) {
		track.push({time: t, hz: tracker.estimate(samples, Math.round(t * sampleRate))});
	}
	return track;
}

// Draw pitch values as dots on the axis. points is a list of [x, hz]
// (canvas pixels, Hz); unvoiced and off-scale values are skipped.
export function drawPitch(context, points, scale, height, ratio, colour) {
	context.fillStyle = colour;
	context.strokeStyle = 'rgba(0, 0, 0, .7)';
	context.lineWidth = ratio;
	let radius = 2 * ratio;
	for (let [x, hz] of points) {
		if (!(hz >= scale.min && hz <= scale.max)) continue;
		context.beginPath();
		context.arc(x, (1 - frequencyFraction(hz, scale)) * height, radius, 0, 2 * Math.PI);
		context.fill();
		context.stroke();
	}
}

// Faint horizontal lines at the axis labels, for reading values off.
export function drawGrid(context, scale, width, height, ratio) {
	context.strokeStyle = 'rgba(255, 255, 255, .15)';
	context.lineWidth = ratio;
	context.beginPath();
	for (let {frequency} of frequencyTicks(scale)) {
		let y = Math.round((1 - frequencyFraction(frequency, scale)) * height) + .5;
		context.moveTo(0, y);
		context.lineTo(width, y);
	}
	context.stroke();
}

// The frequency scale. Views compute columns up to at least
// COMPUTED_MAX_FREQUENCY and show up to their max-frequency, so changing the
// scale within that range only redraws.
export const COMPUTED_MAX_FREQUENCY = 5000;
export const SCALE_LIMITS = Object.freeze([100, 5000]);

// The scale after a ctrl+wheel (or pinch) step of deltaY pixels: zoomed
// exponentially, kept within SCALE_LIMITS, in steps of 50 Hz.
export function zoomedScale(maxFrequency, deltaY) {
	let scaled = maxFrequency * Math.exp(deltaY * .01);
	return Math.round(Math.min(SCALE_LIMITS[1], Math.max(SCALE_LIMITS[0], scaled)) / 50) * 50;
}

// Round values to label an axis with: [{frequency, label}], about 3-9 of
// them. A log axis uses the densest of a few sets of round numbers that
// fits.
const LOG_TICKS = [
	[50, 100, 200, 500, 1000, 2000, 5000],
	[50, 75, 100, 150, 200, 300, 500, 700, 1000, 1500, 2000, 3000, 5000],
	[50, 60, 70, 80, 90, 100, 125, 150, 175, 200, 250, 300, 400, 500, 600, 700, 800, 1000,
		1250, 1500, 2000, 2500, 3000, 4000, 5000],
];
export function frequencyTicks(scale) {
	let label = f => f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`;
	let inRange = f => f >= scale.min - 1e-9 && f <= scale.max + 1e-9;
	let frequencies;
	if (scale.log) {
		// The densest set that fits with at most one label dropped.
		for (let set of LOG_TICKS.slice().reverse()) {
			let candidate = set.filter(inRange);
			frequencies = spaced(candidate, scale);
			if (frequencies.length <= 9 && candidate.length - frequencies.length <= 1) break;
		}
	} else {
		let span = scale.max - scale.min;
		let step = [50, 100, 200, 250, 500, 1000, 2000].find(s => span / s <= 6) || 5000;
		frequencies = [];
		for (let f = Math.ceil(scale.min / step) * step; f <= scale.max + 1e-9; f += step) frequencies.push(f);
		frequencies = spaced(frequencies, scale);
	}
	return frequencies.map(f => ({frequency: f, label: label(f)}));
}

// Drop labels that would crowd the one above them, top down: at least a
// tenth of the height apart, more for a label at the very bottom, which is
// drawn above its line (e.g. 75 Hz under 100 Hz on a log axis from 75 Hz).
function spaced(frequencies, scale) {
	let kept = [];
	for (let f of frequencies.slice().reverse()) {
		let fraction = frequencyFraction(f, scale);
		let gap = fraction < .04 ? .16 : .1;
		if (!kept.length || frequencyFraction(kept[kept.length - 1], scale) - fraction >= gap) kept.push(f);
	}
	return kept.reverse();
}

// Fill an axis element with frequency labels, for the elements. (The only
// function here that uses the DOM, and only when called.)
export function renderFrequencyAxis(axis, scale) {
	axis.textContent = '';
	for (let {frequency, label} of frequencyTicks(scale)) {
		let fraction = frequencyFraction(frequency, scale);
		let span = document.createElement('span');
		span.textContent = label;
		span.style.top = `${(1 - fraction) * 100}%`;
		// Keep the labels at the ends inside the axis.
		if (fraction < .04) span.style.transform = 'translateY(-100%)';
		if (fraction > .96) span.style.transform = 'none';
		axis.appendChild(span);
	}
}

// Mono samples from an AudioBuffer (channels averaged), or from
// {samples, sampleRate}.
export function monoSamples(audio) {
	if (audio.samples) return {samples: audio.samples, sampleRate: audio.sampleRate};
	let samples = new Float32Array(audio.length);
	for (let c = 0; c < audio.numberOfChannels; c++) {
		let channel = audio.getChannelData(c);
		for (let i = 0; i < samples.length; i++) samples[i] += channel[i] / audio.numberOfChannels;
	}
	return {samples, sampleRate: audio.sampleRate};
}
