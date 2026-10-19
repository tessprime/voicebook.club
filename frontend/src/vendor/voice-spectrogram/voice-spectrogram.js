// SPDX-License-Identifier: MIT
// (See LICENSE in this folder; the rest of the repository is AGPL-3.0.)

// <voice-spectrogram>: a recording's spectrogram, with rows of aligned
// words and phones underneath, a playback cursor, click-to-seek, and
// zooming and scrolling through long recordings.
//
// Framework-free custom element; see README.md for the API. It holds no
// application state: the host sets properties and listens for events.

import {DEFAULTS, COMPUTED_MAX_FREQUENCY, IMAGE_ROWS, computeSpectrogram, colormap, monoSamples,
	zoomedScale, renderFrequencyAxis, decimate, computePitchTrack, drawPitch, drawGrid,
	frequencyScale, rowBins, paintColumn} from './spectrogram.js';
import {PitchTracker} from './pitch.js';

// Without a window-length attribute, the window follows the scale: at
// NARROWBAND_MAX and below, a 25 ms window resolves the harmonics (about
// 52 Hz resolution); above, the 5 ms window shows formants (about 260 Hz).
const NARROWBAND_MAX = 2000;
const NARROWBAND = Object.freeze({windowLength: .025, timeStep: .005, maxFrequency: NARROWBAND_MAX});

// Loading this file must not fail during server-side rendering (e.g. in
// Next.js), where there's no HTMLElement; the element is only defined in
// browsers.
const Base = typeof HTMLElement == 'undefined' ? class {} : HTMLElement;

// voicebook patch: the styles are a constructed stylesheet rather than a
// <style> element, which a Content-Security-Policy without
// 'unsafe-inline' in style-src blocks.
const STYLES = `
	:host {
		display: block;
		position: relative;
		font: inherit;
		color: var(--vs-text, currentColor);
		background: var(--vs-background, transparent);
		user-select: none;
		-webkit-user-select: none;
	}
	:host([hidden]) { display: none; }
	.plot {
		position: relative;
		height: var(--vs-height, 200px);
		margin-left: var(--vs-axis-width, 3.2em);
		cursor: crosshair;
		touch-action: pan-y;
	}
	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
	}
	.axis {
		position: absolute;
		top: 0;
		bottom: 0;
		right: 100%;
		width: var(--vs-axis-width, 3.2em);
		font-size: .75em;
		opacity: .8;
	}
	.axis span {
		position: absolute;
		right: .4em;
		transform: translateY(-50%);
		white-space: nowrap;
	}
	.axis { cursor: ns-resize; }
	.plot.dragging { cursor: grabbing; }
	.cursor {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 0;
		border-left: 2px solid var(--vs-cursor, #ffd400);
		pointer-events: none;
		display: none;
	}
	.tier {
		position: relative;
		height: var(--vs-tier-height, 1.6em);
		margin-left: var(--vs-axis-width, 3.2em);
		border-top: 1px solid var(--vs-border, rgba(128, 128, 128, .5));
	}
	.track {
		position: absolute;
		inset: 0;
		overflow: hidden;
	}
	.tier-name {
		position: absolute;
		right: calc(100% + .4em);
		top: 50%;
		transform: translateY(-50%);
		font-size: .75em;
		opacity: .8;
	}
	.segment {
		position: absolute;
		top: 0;
		bottom: 0;
		box-sizing: border-box;
		border-left: 1px solid var(--vs-border, rgba(128, 128, 128, .5));
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		white-space: nowrap;
		font-size: .85em;
		cursor: pointer;
	}
	.segment:hover { background: var(--vs-hover, rgba(128, 128, 128, .25)); }
	.segment.current {
		background: var(--vs-current, #ffd400);
		color: var(--vs-current-text, black);
	}
	.segment[data-kind=vowel] { color: var(--vs-vowel, inherit); font-weight: bold; }
	.segment.current[data-kind] { color: var(--vs-current-text, black); }
	/* The levels row: each interval coloured by its value (see _renderTier). */
	.levels {
		height: var(--vs-levels-height, .7em);
		border-top: none;
		margin-bottom: 2px;
	}
	.levels .tier-name { font-size: .65em; }
	.levels .segment { border-left: none; }
	/* Faded: thinner rather than translucent, so the colour stays true. */
	.levels .segment[data-faded] { top: 30%; bottom: 30%; }
	.levels .segment.current { box-shadow: inset 0 0 0 2px var(--vs-current, #ffd400); }
	.overview {
		position: relative;
		height: var(--vs-overview-height, 8px);
		margin-left: var(--vs-axis-width, 3.2em);
		margin-top: 2px;
		background: var(--vs-hover, rgba(128, 128, 128, .25));
		border-radius: 4px;
		cursor: pointer;
		touch-action: none;
	}
	.overview .window {
		position: absolute;
		top: 0;
		bottom: 0;
		min-width: 4px;
		border-radius: 4px;
		background: var(--vs-overview, rgba(128, 128, 128, .8));
	}
`;

let styleSheet = null;
function sharedStyleSheet() {
	if (!styleSheet) {
		styleSheet = new CSSStyleSheet();
		styleSheet.replaceSync(STYLES);
	}
	return styleSheet;
}

const TEMPLATE = `
<div class="tier levels" part="levels" hidden><span class="tier-name"></span><div class="track"></div></div>
<div class="plot" part="plot">
	<canvas part="canvas"></canvas>
	<div class="axis" part="axis"></div>
	<div class="cursor" part="cursor"></div>
</div>
<div class="tier words" part="words"><span class="tier-name"></span><div class="track"></div></div>
<div class="tier phones" part="phones"><span class="tier-name"></span><div class="track"></div></div>
<div class="overview" part="overview" hidden><div class="window"></div></div>
`;

export class VoiceSpectrogram extends Base {
	static get observedAttributes() {
		return ['max-frequency', 'min-frequency', 'frequency-scale', 'window-length', 'dynamic-range',
			'colormap', 'view-duration', 'show-pitch', 'levels-label'];
	}

	constructor() {
		super();
		this.attachShadow({mode: 'open'});
		this.shadowRoot.adoptedStyleSheets = [sharedStyleSheet()];
		this.shadowRoot.innerHTML = TEMPLATE;
		this._plot = this.shadowRoot.querySelector('.plot');
		this._canvas = this.shadowRoot.querySelector('canvas');
		this._axis = this.shadowRoot.querySelector('.axis');
		this._cursor = this.shadowRoot.querySelector('.cursor');
		this._overview = this.shadowRoot.querySelector('.overview');
		this._overviewWindow = this.shadowRoot.querySelector('.overview .window');
		this._tiers = {
			levels: this.shadowRoot.querySelector('.tier.levels'),
			words: this.shadowRoot.querySelector('.tier.words'),
			phones: this.shadowRoot.querySelector('.tier.phones'),
		};
		this._tiers.levels.querySelector('.tier-name').textContent = 'Level';
		this._tiers.words.querySelector('.tier-name').textContent = 'Words';
		this._tiers.phones.querySelector('.tier-name').textContent = 'Phones';
		this._levels = [];

		this._audio = null;
		this._words = [];
		this._phones = [];
		this._currentTime = null;
		// Spectrograms computed so far, by analysis ('broadband', 'narrowband'
		// or a custom window): {spectrogram, image}, the image one pixel per
		// column and bin. Switching scales back and forth reuses them.
		this._analyses = new Map();
		this._computedPitch = null; // [{time, hz}] from the audio, once needed
		this._pitchTrack = null;    // set by the host instead, if it has one
		this._computeTimer = null;
		this._viewStart = 0;       // the time range shown: start, and length
		this._viewSpan = Infinity; // (clamped to the recording; see _clampView)

		// On the spectrogram: click to seek, drag to scroll.
		this._plot.addEventListener('pointerdown', event => {
			if (event.button != 0) return;
			this._plot.setPointerCapture(event.pointerId);
			this._drag = {x: event.clientX, start: this.viewStart, moved: false};
		});
		this._plot.addEventListener('pointermove', event => {
			let drag = this._drag;
			if (!drag) return;
			let dx = event.clientX - drag.x;
			if (Math.abs(dx) > 4) drag.moved = true;
			if (drag.moved) {
				this._plot.classList.add('dragging');
				this.setView(drag.start - dx / this._plot.clientWidth * this._span(), null);
			}
		});
		let endDrag = event => {
			let drag = this._drag;
			this._drag = null;
			this._plot.classList.remove('dragging');
			if (drag && !drag.moved && event.type == 'pointerup') this._seek(this._timeAt(event.clientX), null);
		};
		this._plot.addEventListener('pointerup', endDrag);
		this._plot.addEventListener('pointercancel', endDrag);

		// Ctrl+wheel (and trackpad pinch) zooms time around the pointer, or
		// over the frequency axis, the frequency scale; horizontal or
		// shift+wheel scrolls. Plain vertical scrolling is left to the page.
		this.addEventListener('wheel', event => {
			if (event.ctrlKey && event.composedPath().includes(this._axis)) {
				event.preventDefault();
				let value = Math.max(zoomedScale(this.maxFrequency, event.deltaY), Math.ceil(this.frequencyScale.min / 50 + 1) * 50);
				if (value != this.maxFrequency) {
					this.setAttribute('max-frequency', value);
					this.dispatchEvent(new CustomEvent('scalechange', {detail: {maxFrequency: value}}));
				}
				return;
			}
			if (!this.duration) return;
			let span = this._span();
			let unit = event.deltaMode == 1 ? 16 : event.deltaMode == 2 ? this._plot.clientWidth : 1;
			if (event.ctrlKey) {
				event.preventDefault();
				let time = this._timeAt(event.clientX);
				let fraction = (time - this.viewStart) / span;
				let newSpan = span * Math.exp(event.deltaY * unit * .01);
				this.setView(time - fraction * newSpan, time - fraction * newSpan + newSpan);
			} else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
				event.preventDefault();
				let delta = (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit;
				this.setView(this.viewStart + delta / this._plot.clientWidth * span, null);
			}
		}, {passive: false});

		// The overview strip: click or drag to move the view there.
		let moveOverview = event => {
			let rect = this._overview.getBoundingClientRect();
			let time = (event.clientX - rect.left) / rect.width * this.duration;
			this.setView(time - this._span() / 2, null);
		};
		this._overview.addEventListener('pointerdown', event => {
			this._overview.setPointerCapture(event.pointerId);
			moveOverview(event);
		});
		this._overview.addEventListener('pointermove', event => {
			if (this._overview.hasPointerCapture(event.pointerId)) moveOverview(event);
		});
		for (let [tier, element] of Object.entries(this._tiers)) {
			element.addEventListener('click', event => {
				let segment = event.target.closest('.segment');
				if (!segment) return;
				let item = this._items(tier)[segment.dataset.index];
				this._seek(item.start, {tier: tier.slice(0, -1), ...item});
			});
		}

		// Properties set before the element was defined (e.g. by a framework
		// that renders first and loads this module later) are plain fields
		// that hide the setters; reapply them through the setters.
		for (let name of ['audio', 'words', 'phones', 'levels', 'currentTime', 'pitchTrack']) {
			if (Object.prototype.hasOwnProperty.call(this, name)) {
				let value = this[name];
				delete this[name];
				this[name] = value;
			}
		}
	}

	connectedCallback() {
		if (!this._resizeObserver && typeof ResizeObserver != 'undefined') {
			this._resizeObserver = new ResizeObserver(() => {
				this._scheduleCompute();
				this._draw();
			});
			this._resizeObserver.observe(this._plot);
		}
		this._scheduleCompute();
		this._draw();
	}

	disconnectedCallback() {
		if (this._resizeObserver) this._resizeObserver.disconnect();
		this._resizeObserver = null;
	}

	attributeChangedCallback(name) {
		if (name == 'levels-label') {
			this._tiers.levels.querySelector('.tier-name').textContent = this.getAttribute(name) || 'Level';
		} else if (name == 'view-duration') {
			this._resetView();
		} else if (['colormap', 'dynamic-range', 'min-frequency', 'frequency-scale'].includes(name)) {
			// Only repainting (done as it's drawn).
			this._renderAxis();
			this._draw();
		} else if (name == 'window-length') {
			this._analyses.clear();
			this._refresh();
		} else {
			// The scale (or showing the pitch): computes what the new setting
			// needs, if it isn't cached.
			this._refresh();
		}
	}

	// The recording: an AudioBuffer, or {samples: Float32Array, sampleRate}.
	get audio() { return this._audio; }
	set audio(audio) {
		this._audio = audio;
		this._analyses.clear();
		this._computedPitch = null;
		this._resetView();
		this._refresh();
	}

	// The pitch drawn over the spectrogram: [{time, hz}] (hz null when
	// unvoiced). Computed from the audio (YIN, as the live view) unless the
	// host sets its own, e.g. from a more accurate analysis.
	get pitchTrack() { return this._pitchTrack || this._computedPitch; }
	set pitchTrack(track) {
		this._pitchTrack = track || null;
		this._refresh();
	}

	// Whether the pitch is drawn: the show-pitch attribute ("on" or "off"),
	// or by default when the scale is low enough to show it (narrowband).
	get showPitch() {
		let setting = this.getAttribute('show-pitch');
		if (setting == 'on' || setting == 'off') return setting == 'on';
		return this.maxFrequency <= NARROWBAND_MAX;
	}

	// Aligned words and phones: arrays of {start, end, label}, times in
	// seconds. Phones may have a kind ('vowel', 'sonorant', 'obstruent')
	// for styling. Items with an empty label (silence) are drawn blank.
	get words() { return this._words; }
	set words(words) {
		this._words = words || [];
		this._renderTier('words');
	}
	get phones() { return this._phones; }
	set phones(phones) {
		this._phones = phones || [];
		this._renderTier('phones');
	}

	// A colour strip above the spectrogram: intervals coloured by a value
	// from 0 to 1, e.g. how resonant each phone sounds: [{start, end, value,
	// faded?}]. The colour runs from --vs-level-low to --vs-level-high; the
	// value shows on hover. faded draws it thinner (e.g. less reliable
	// values). Name the row with the levels-label attribute.
	get levels() { return this._levels; }
	set levels(levels) {
		this._levels = levels || [];
		this._renderTier('levels');
	}

	_items(tier) {
		return tier == 'levels' ? this._levels : tier == 'words' ? this._words : this._phones;
	}

	// The playback position in seconds, or null to hide the cursor. The
	// word and phone under it are highlighted.
	get currentTime() { return this._currentTime; }
	set currentTime(time) {
		this._currentTime = time == null || isNaN(time) ? null : Number(time);
		// Page the view along to keep the cursor in sight (not while the
		// user drags it).
		let t = this._currentTime, span = this._span();
		if (t != null && !this._drag && (t < this.viewStart || t > this.viewStart + .95 * span)) {
			this.setView(t - .1 * span, null);
		}
		this._updateCursor();
	}

	// The time range shown, in seconds. Initially the first view-duration
	// seconds (the attribute), or the whole recording.
	get viewStart() { return this._clampView().start; }
	get viewEnd() {
		let {start, span} = this._clampView();
		return start + span;
	}

	// Show start to end (seconds). end null keeps the current length. Fires
	// 'viewchange' with {start, end}.
	setView(start, end) {
		let span = end == null ? this._span() : end - start;
		let before = this._clampView();
		this._viewStart = start;
		this._viewSpan = span;
		let after = this._clampView();
		this._viewStart = after.start;
		this._viewSpan = after.span;
		this._draw();
		this._layout();
		if (after.start != before.start || after.span != before.span) {
			this.dispatchEvent(new CustomEvent('viewchange', {
				detail: {start: after.start, end: after.start + after.span},
			}));
		}
	}

	_resetView() {
		let duration = parseFloat(this.getAttribute('view-duration'));
		this._viewStart = 0;
		this._viewSpan = isNaN(duration) || duration <= 0 ? Infinity : duration;
		this._draw();
		this._layout();
	}

	// The view within the recording: at least 0.1 s, at most all of it.
	_clampView() {
		let duration = this.duration;
		if (!duration) return {start: 0, span: 0};
		let span = Math.min(duration, Math.max(Math.min(.1, duration), this._viewSpan));
		let start = Math.min(duration - span, Math.max(0, this._viewStart));
		return {start, span};
	}

	_span() { return this._clampView().span; }

	// The time at a horizontal page position over the plot.
	_timeAt(clientX) {
		let rect = this._plot.getBoundingClientRect();
		return this.viewStart + (clientX - rect.left) / rect.width * this._span();
	}

	// Where a time falls across the plot, from 0 (left edge) to 1 (right).
	_fraction(time) {
		let {start, span} = this._clampView();
		return span ? (time - start) / span : 0;
	}

	get duration() {
		let audio = this._audio;
		if (audio) return audio.samples ? audio.samples.length / audio.sampleRate : audio.duration;
		let last = this._words[this._words.length - 1] || this._phones[this._phones.length - 1];
		return last ? last.end : 0;
	}

	// The top of the frequency scale, Hz (the max-frequency attribute).
	get maxFrequency() { return this._options().maxFrequency; }

	// The frequency axis: {min, max, log} (the min-frequency, max-frequency
	// and frequency-scale attributes).
	get frequencyScale() {
		let min = parseFloat(this.getAttribute('min-frequency'));
		return frequencyScale(isNaN(min) ? 0 : min, this.maxFrequency, this.getAttribute('frequency-scale') == 'log');
	}

	_options() {
		let number = (name, fallback) => {
			let value = parseFloat(this.getAttribute(name));
			return isNaN(value) ? fallback : value;
		};
		return {
			maxFrequency: number('max-frequency', DEFAULTS.maxFrequency),
			windowLength: number('window-length', NaN),
			dynamicRange: number('dynamic-range', DEFAULTS.dynamicRange),
			colormap: this.getAttribute('colormap') || 'magma',
		};
	}

	// The analysis the current settings call for: {key, options, decimated}.
	_analysisFor() {
		let {maxFrequency, windowLength} = this._options();
		if (!isNaN(windowLength)) {
			return {key: `window ${windowLength}`, decimated: false,
				options: {windowLength, maxFrequency: Math.max(maxFrequency, COMPUTED_MAX_FREQUENCY)}};
		}
		if (maxFrequency <= NARROWBAND_MAX) return {key: 'narrowband', decimated: true, options: NARROWBAND};
		// Computed to at least 5 kHz, so changing the scale above
		// NARROWBAND_MAX only redraws.
		return {key: 'broadband', decimated: false,
			options: {maxFrequency: Math.max(maxFrequency, COMPUTED_MAX_FREQUENCY)}};
	}

	// The spectrogram to draw: the one the settings call for, or while it's
	// being computed, any other of the same recording.
	_current() {
		let wanted = this._analyses.get(this._analysisFor().key);
		return wanted || this._analyses.values().next().value || null;
	}

	// For tests and debugging: the image being drawn.
	get _image() {
		let current = this._current();
		return current ? current.image : null;
	}

	// Redraw, and compute whatever's missing. Computing takes a while
	// (~0.2 s for 8 s of 44.1 kHz audio), so it waits until the element is
	// visible, and runs once for several changes in a row (e.g. a host
	// switching recordings quickly). A 'render' event follows each
	// computation.
	_refresh() {
		this._renderAxis();
		this._renderTier('levels');
		this._renderTier('words');
		this._renderTier('phones');
		this._draw();
		this._scheduleCompute();
	}

	_needsComputing() {
		if (!this._audio) return false;
		let spectrogram = !this._analyses.has(this._analysisFor().key);
		let pitch = this.showPitch && !this._pitchTrack && !this._computedPitch;
		return spectrogram || pitch;
	}

	_scheduleCompute() {
		if (this._computeTimer != null || !this._needsComputing()) return;
		this._computeTimer = setTimeout(() => {
			this._computeTimer = null;
			let visible = this.isConnected && this._plot.clientWidth > 0;
			if (visible && this._needsComputing()) this._compute();
		}, 0);
	}

	_compute() {
		let audio = this._audio;
		let mono = monoSamples(audio);
		let low = null;  // decimated audio, shared by narrowband and pitch
		let lowRate = () => low || (low = decimate(mono.samples, mono.sampleRate));

		let {key, options, decimated} = this._analysisFor();
		if (!this._analyses.has(key)) {
			let {samples, sampleRate} = decimated ? lowRate() : mono;
			let analysis = {spectrogram: computeSpectrogram(samples, sampleRate, options), image: null};
			this._paint(analysis);
			this._analyses.set(key, analysis);
		}
		if (this.showPitch && !this._pitchTrack && !this._computedPitch) {
			let {samples, sampleRate} = lowRate();
			this._computedPitch = computePitchTrack(samples, sampleRate, new PitchTracker(sampleRate));
		}
		this._renderAxis();
		this._draw();
		this.dispatchEvent(new CustomEvent('render'));
	}

	// Paint a spectrogram into an offscreen canvas for the current axis and
	// colours, one column per spectrogram column and IMAGE_ROWS rows; drawing
	// then only crops and scales it. Repainted when the axis or colours
	// change (tens of ms), never recomputed.
	_paintKey() {
		let {min, max, log} = this.frequencyScale, {dynamicRange, colormap: name} = this._options();
		return [min, max, log, dynamicRange, name].join();
	}

	_paint(analysis) {
		if (typeof document == 'undefined') return;
		let s = analysis.spectrogram;
		let {dynamicRange, colormap: name} = this._options();
		let image = analysis.image || document.createElement('canvas');
		image.width = s.columns;
		image.height = IMAGE_ROWS;
		let context = image.getContext('2d');
		let pixels = context.createImageData(s.columns, IMAGE_ROWS);
		let rows = rowBins(this.frequencyScale, s.binHz, s.bins);
		let table = colormap(name);
		for (let x = 0; x < s.columns; x++) {
			paintColumn(pixels.data, s.columns, x, s.data.subarray(x * s.bins, (x + 1) * s.bins), rows,
				s.maxDb, dynamicRange, table);
		}
		context.putImageData(pixels, 0, 0);
		analysis.image = image;
		analysis.paintKey = this._paintKey();
	}

	_draw() {
		let canvas = this._canvas;
		let ratio = (typeof devicePixelRatio == 'number' && devicePixelRatio) || 1;
		let width = Math.round(this._plot.clientWidth * ratio);
		let height = Math.round(this._plot.clientHeight * ratio);
		if (!width || !height) return;
		if (canvas.width != width || canvas.height != height) {
			canvas.width = width;
			canvas.height = height;
		}
		let context = canvas.getContext('2d');
		context.clearRect(0, 0, width, height);
		let current = this._current();
		let scale = this.frequencyScale;
		let {start, span} = this._clampView();
		if (current && current.image) {
			if (current.paintKey != this._paintKey()) this._paint(current);
			let s = current.spectrogram;
			context.imageSmoothingEnabled = true;
			context.drawImage(current.image, start / s.timeStep, 0, span / s.timeStep, IMAGE_ROWS,
				0, 0, width, height);
		}
		if (this._audio) drawGrid(context, scale, width, height, ratio);
		let track = this.pitchTrack;
		if (this.showPitch && track && span) {
			let points = [];
			for (let point of track) {
				if (point.time >= start && point.time <= start + span) {
					points.push([(point.time - start) / span * width, point.hz]);
				}
			}
			let colour = getComputedStyle(this).getPropertyValue('--vs-pitch').trim() || '#4dd0ff';
			drawPitch(context, points, scale, height, ratio, colour);
		}
		this._updateCursor();
	}

	_renderAxis() {
		this._axis.textContent = '';
		if (!this._audio) return;
		renderFrequencyAxis(this._axis, this.frequencyScale);
	}

	_renderTier(tier) {
		let element = this._tiers[tier];
		let track = element.querySelector('.track');
		track.textContent = '';
		let items = this._items(tier);
		let duration = this.duration;
		element.hidden = !items.length;
		if (!duration) return;
		let colours = tier == 'levels' ? this._levelColours() : null;
		items.forEach((item, index) => {
			let segment = document.createElement('div');
			segment.className = 'segment';
			segment.dataset.index = index;
			if (item.kind) segment.dataset.kind = item.kind;
			let time = `${item.start.toFixed(2)}–${item.end.toFixed(2)} s`;
			if (colours) {
				let value = Math.min(1, Math.max(0, item.value));
				let [low, high] = colours;
				segment.style.background = `rgb(${low.map((c, i) => Math.round(c + (high[i] - c) * value))})`;
				if (item.faded) segment.dataset.faded = '';
				segment.title = `${Math.round(value * 100)}%: ${time}`;
			} else {
				segment.textContent = item.label || '';
				segment.title = item.label ? `${item.label}: ${time}` : '';
			}
			track.appendChild(segment);
		});
		this._layout();
	}

	// The levels row's colours, [r, g, b] for 0 and 1: the --vs-level-low and
	// --vs-level-high properties, by default the blue and red-orange of the
	// gender voice visualization's resonance axis.
	_levelColours() {
		let parse = (name, fallback) => {
			let value = getComputedStyle(this).getPropertyValue(name).trim();
			let match = value.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
			return match ? match.slice(1).map(hex => parseInt(hex, 16)) : fallback;
		};
		return [parse('--vs-level-low', [0, 100, 255]), parse('--vs-level-high', [255, 40, 0])];
	}

	// Position the intervals, the overview and the cursor for the view.
	_layout() {
		for (let [tier, element] of Object.entries(this._tiers)) {
			let items = this._items(tier);
			for (let segment of element.querySelectorAll('.segment')) {
				let item = items[segment.dataset.index];
				let left = this._fraction(item.start), right = this._fraction(item.end);
				let shown = right > 0 && left < 1;
				segment.style.display = shown ? '' : 'none';
				if (shown) {
					segment.style.left = `${left * 100}%`;
					segment.style.width = `${(right - left) * 100}%`;
				}
			}
		}
		let duration = this.duration, {start, span} = this._clampView();
		this._overview.hidden = !duration || span >= duration;
		if (duration) {
			this._overviewWindow.style.left = `${start / duration * 100}%`;
			this._overviewWindow.style.width = `${span / duration * 100}%`;
		}
		this._updateCursor();
	}

	_updateCursor() {
		let time = this._currentTime, duration = this.duration;
		let visible = time != null && duration > 0;
		let fraction = visible ? this._fraction(time) : -1;
		this._cursor.style.display = fraction >= 0 && fraction <= 1 ? 'block' : 'none';
		this._cursor.style.left = `${fraction * 100}%`;
		for (let [tier, element] of Object.entries(this._tiers)) {
			let items = this._items(tier);
			for (let segment of element.querySelectorAll('.segment')) {
				let item = items[segment.dataset.index];
				let meaningful = tier == 'levels' || !!item.label;
				segment.classList.toggle('current',
					visible && meaningful && item.start <= time && time < item.end);
			}
		}
	}

	_seek(time, segment) {
		this.dispatchEvent(new CustomEvent('seek', {
			bubbles: true,
			detail: {time: Math.max(0, Math.min(this.duration, time)), segment},
		}));
	}
}

if (typeof customElements != 'undefined' && !customElements.get('voice-spectrogram')) {
	customElements.define('voice-spectrogram', VoiceSpectrogram);
}
