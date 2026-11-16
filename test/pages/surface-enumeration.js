// What the platform lists and measures for a page, collected by the page's
// own code (the surface-enumeration suite): devices, voices, WebGL and WebGPU
// limits, plugins, languages, client hints, permissions, fonts, locales,
// media queries, window geometry, storage, codecs, audio and canvas
// readbacks. One file for a document (a script element) and a worker
// (importScripts): `__surfaceEnumeration()` resolves with one record, each
// section the values in the order the platform gave them, or how it failed.
(() => {
	const scope = globalThis;
	const inWorker = typeof scope.document === 'undefined';
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const failure = (error) =>
		`threw ${error?.constructor?.name}/${error?.name}: ${error?.message}`;
	const hash = (text) => {
		let h = 0x811c9dc5;
		for (let i = 0; i < text.length; i++) {
			h ^= text.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
		return `${text.length}:${(h >>> 0).toString(16)}`;
	};
	const tag = (value) => Object.prototype.toString.call(value);
	/** a value as JSON can carry it, typed arrays and platform objects named */
	const plain = (value, depth = 0) => {
		if (value === null || value === undefined) return String(value);
		const type = typeof value;
		if (type === 'number' || type === 'boolean' || type === 'string')
			return value;
		if (type === 'bigint') return `bigint ${value}`;
		if (type === 'function') return `function ${value.name}`;
		if (ArrayBuffer.isView(value))
			return `${tag(value)} ${Array.from(value).join(',')}`;
		if (depth > 4) return tag(value);
		if (Array.isArray(value))
			return value.map((item) => plain(item, depth + 1));
		const out = { '(class)': tag(value) };
		// own keys, then what the prototypes' getters answer, in their order
		for (const key of Reflect.ownKeys(value))
			if (typeof key === 'string') out[key] = plain(value[key], depth + 1);
		for (
			let proto = Object.getPrototypeOf(value);
			proto && proto !== Object.prototype;
			proto = Object.getPrototypeOf(proto)
		)
			for (const key of Object.getOwnPropertyNames(proto)) {
				const d = Object.getOwnPropertyDescriptor(proto, key);
				if (!d.get || key in out) continue;
				try {
					out[key] = plain(value[key], depth + 1);
				} catch (error) {
					out[key] = failure(error);
				}
			}
		return out;
	};

	const sections = {};
	const section = (name, where, run) => {
		if (where === 'document' && inWorker) return;
		sections[name] = run;
	};

	section('mediaDevices.enumerateDevices', 'document', async () => {
		const devices = await navigator.mediaDevices.enumerateDevices();
		const groups = [];
		return devices.map((device) => {
			if (!groups.includes(device.groupId)) groups.push(device.groupId);
			return {
				class: tag(device),
				kind: device.kind,
				label: device.label,
				// an id is the browser's random name for the device: its
				// shape and which entries share one are what can be compared
				deviceId: device.deviceId.replace(/[0-9a-f]/g, 'x'),
				group: device.groupId === '' ? '' : groups.indexOf(device.groupId),
				json: Object.keys(device.toJSON()).join(),
			};
		});
	});

	section('speechSynthesis.getVoices', 'document', async () => {
		const voice = (v) => ({
			name: v.name,
			lang: v.lang,
			localService: v.localService,
			default: v.default,
			voiceURI: v.voiceURI,
		});
		let fired = 0;
		speechSynthesis.addEventListener('voiceschanged', () => fired++);
		const atOnce = speechSynthesis.getVoices().map(voice);
		await sleep(1200);
		return {
			atOnce,
			later: speechSynthesis.getVoices().map(voice),
			// whether the list was announced, not how often: the count
			// follows how the speech service starts
			voiceschanged: fired > 0,
			sameArrayTwice:
				speechSynthesis.getVoices() === speechSynthesis.getVoices(),
			pending: speechSynthesis.pending,
			speaking: speechSynthesis.speaking,
			paused: speechSynthesis.paused,
		};
	});

	const webgl = (kind) => async () => {
		const canvas = inWorker
			? new OffscreenCanvas(64, 64)
			: document.createElement('canvas');
		const gl = canvas.getContext(kind);
		if (!gl) return 'no context';
		const out = {
			class: tag(gl),
			attributes: gl.getContextAttributes(),
			extensions: gl.getSupportedExtensions(),
			drawingBuffer: [
				gl.drawingBufferWidth,
				gl.drawingBufferHeight,
				gl.drawingBufferColorSpace,
			],
			parameters: {},
			precision: {},
			extensionParameters: {},
		};
		// every constant of the context, asked as a parameter: what is no
		// parameter answers null and leaves an error, which is read too
		const constants = [];
		for (
			let proto = Object.getPrototypeOf(gl);
			proto && proto !== Object.prototype;
			proto = Object.getPrototypeOf(proto)
		)
			for (const key of Object.getOwnPropertyNames(proto)) {
				const d = Object.getOwnPropertyDescriptor(proto, key);
				if (typeof d.value === 'number') constants.push([key, d.value]);
			}
		out.constants = constants.length;
		for (const [key, value] of constants) {
			let answer;
			try {
				answer = plain(gl.getParameter(value));
			} catch (error) {
				answer = failure(error);
			}
			const error = gl.getError();
			if (answer !== 'null' || error === 0)
				out.parameters[key] = error ? [answer, error] : answer;
		}
		for (const shader of ['VERTEX_SHADER', 'FRAGMENT_SHADER'])
			for (const precision of [
				'LOW_FLOAT',
				'MEDIUM_FLOAT',
				'HIGH_FLOAT',
				'LOW_INT',
				'MEDIUM_INT',
				'HIGH_INT',
			]) {
				const format = gl.getShaderPrecisionFormat(gl[shader], gl[precision]);
				out.precision[`${shader} ${precision}`] = format
					? [format.rangeMin, format.rangeMax, format.precision].join()
					: 'null';
			}
		for (const name of out.extensions) {
			const extension = gl.getExtension(name);
			if (!extension) {
				out.extensionParameters[name] = 'null';
				continue;
			}
			const values = {};
			for (
				let proto = Object.getPrototypeOf(extension);
				proto && proto !== Object.prototype;
				proto = Object.getPrototypeOf(proto)
			)
				for (const key of Object.getOwnPropertyNames(proto)) {
					const d = Object.getOwnPropertyDescriptor(proto, key);
					if (typeof d.value !== 'number') continue;
					let answer;
					try {
						answer = plain(gl.getParameter(d.value));
					} catch (error) {
						answer = failure(error);
					}
					const error = gl.getError();
					values[key] = error ? [answer, error] : answer;
				}
			out.extensionParameters[name] = values;
		}
		return out;
	};
	section('webgl', 'both', webgl('webgl'));
	section('webgl2', 'both', webgl('webgl2'));

	section('webgpu', 'both', async () => {
		if (!navigator.gpu) return 'no navigator.gpu';
		const out = {
			preferredCanvasFormat: navigator.gpu.getPreferredCanvasFormat(),
			wgslLanguageFeatures: [...navigator.gpu.wgslLanguageFeatures],
		};
		const adapter = await navigator.gpu.requestAdapter();
		if (!adapter) return { ...out, adapter: 'null' };
		out.info = plain(adapter.info);
		out.features = [...adapter.features];
		out.limits = plain(adapter.limits);
		return out;
	});

	section('navigator.plugins', 'document', () => {
		const { plugins, mimeTypes } = navigator;
		const plugin = (p) =>
			p && {
				class: tag(p),
				name: p.name,
				filename: p.filename,
				description: p.description,
				length: p.length,
				types: Array.from(p, (m) => m.type),
				first: p[0] === p.item(0),
				named: p[0] && p.namedItem(p[0].type) === p[0],
				keys: Object.keys(p).join(),
			};
		const mime = (m) =>
			m && {
				class: tag(m),
				type: m.type,
				suffixes: m.suffixes,
				description: m.description,
				plugin: m.enabledPlugin?.name,
			};
		const attempt = (run) => {
			try {
				return plain(run());
			} catch (error) {
				return failure(error);
			}
		};
		const inKeys = [];
		for (const key in plugins) inKeys.push(key);
		return {
			class: [tag(plugins), tag(mimeTypes)],
			length: [plugins.length, mimeTypes.length],
			plugins: Array.from(plugins, plugin),
			mimeTypes: Array.from(mimeTypes, mime),
			keys: [Object.keys(plugins).join(), Object.keys(mimeTypes).join()],
			names: [
				Object.getOwnPropertyNames(plugins).join(),
				Object.getOwnPropertyNames(mimeTypes).join(),
			],
			forIn: inKeys.join(),
			item: [
				plugins.item(0) === plugins[0],
				plugins.item(99),
				plugins[99],
				attempt(() => plugins.item()),
				attempt(() => plugins.item('1')?.name),
				attempt(() => plugins.item(4294967296)?.name),
				attempt(() => plugins.item(-1)),
			],
			namedItem: [
				plugins[0] ? plugins.namedItem(plugins[0].name) === plugins[0] : null,
				plugins.namedItem('nothing by this name'),
				attempt(() => plugins.namedItem()),
				plugins['PDF Viewer'] === plugins.namedItem('PDF Viewer'),
				mimeTypes['application/pdf'] === mimeTypes.namedItem('application/pdf'),
				mimeTypes.namedItem('text/nothing'),
			],
			same: [
				navigator.plugins === navigator.plugins,
				navigator.mimeTypes === navigator.mimeTypes,
				plugins[0] === plugins[0],
				mimeTypes[0]?.enabledPlugin === plugins[0],
			],
			json: JSON.stringify(plugins),
			refresh: attempt(() => plugins.refresh()),
			pdfViewerEnabled: navigator.pdfViewerEnabled,
			javaEnabled: navigator.javaEnabled(),
		};
	});

	section('navigator.languages', 'both', () => ({
		language: navigator.language,
		languages: [...navigator.languages],
		frozen: Object.isFrozen(navigator.languages),
		sameTwice: navigator.languages === navigator.languages,
		class: tag(navigator.languages),
	}));

	section('navigator.userAgentData', 'both', async () => {
		const data = navigator.userAgentData;
		if (!data) return 'no userAgentData';
		const hints = [
			'architecture',
			'bitness',
			'formFactors',
			'fullVersionList',
			'model',
			'platformVersion',
			'uaFullVersion',
			'wow64',
		];
		const orders = {};
		for (const order of [
			hints,
			[...hints].reverse(),
			['model', 'architecture'],
			['wow64', 'bitness', 'bogus hint', 'model'],
			[],
		]) {
			const values = await data.getHighEntropyValues(order);
			orders[order.join()] = [Object.keys(values).join(), values];
		}
		let none;
		try {
			none = plain(await data.getHighEntropyValues());
		} catch (error) {
			none = failure(error);
		}
		return {
			brands: data.brands,
			mobile: data.mobile,
			platform: data.platform,
			json: [Object.keys(data.toJSON()).join(), data.toJSON()],
			frozen: [Object.isFrozen(data.brands), data.brands === data.brands],
			orders,
			none,
			userAgent: navigator.userAgent,
			appVersion: navigator.appVersion,
			platformString: navigator.platform,
		};
	});

	section('navigator.permissions.query', 'both', async () => {
		const out = {};
		for (const name of [
			'geolocation',
			'notifications',
			'push',
			'midi',
			'camera',
			'microphone',
			'background-fetch',
			'background-sync',
			'persistent-storage',
			'ambient-light-sensor',
			'accelerometer',
			'gyroscope',
			'magnetometer',
			'screen-wake-lock',
			'nfc',
			'display-capture',
			'clipboard-read',
			'clipboard-write',
			'payment-handler',
			'idle-detection',
			'periodic-background-sync',
			'storage-access',
			'top-level-storage-access',
			'window-management',
			'local-fonts',
			'captured-surface-control',
			'speaker-selection',
			'keyboard-lock',
			'pointer-lock',
			'fullscreen',
			'web-app-installation',
			'no such permission',
		])
			try {
				const status = await navigator.permissions.query(
					name === 'push' ? { name, userVisibleOnly: true } : { name },
				);
				out[name] = [status.state, status.name, tag(status), status.onchange];
			} catch (error) {
				out[name] = failure(error);
			}
		try {
			out['(no argument)'] = plain(await navigator.permissions.query());
		} catch (error) {
			out['(no argument)'] = failure(error);
		}
		return out;
	});

	section('navigator.getGamepads', 'document', () => {
		const pads = navigator.getGamepads();
		return {
			class: tag(pads),
			length: pads.length,
			items: Array.from(pads, (pad) => pad && pad.id),
			sameTwice: navigator.getGamepads() === navigator.getGamepads(),
		};
	});

	section('navigator.keyboard.getLayoutMap', 'document', async () => {
		if (!navigator.keyboard) return 'no navigator.keyboard';
		const map = await navigator.keyboard.getLayoutMap();
		return { class: tag(map), size: map.size, entries: [...map.entries()] };
	});

	section('fonts', 'both', async () => {
		const fonts = inWorker ? scope.fonts : document.fonts;
		const out = {
			class: tag(fonts),
			size: fonts.size,
			status: fonts.status,
			faces: Array.from(fonts, (face) => [
				face.family,
				face.style,
				face.status,
			]),
			check: [
				'12px serif',
				'12px Arial',
				'12px "No Such Font Anywhere"',
				'12px monospace',
			].map((font) => {
				try {
					return fonts.check(font);
				} catch (error) {
					return failure(error);
				}
			}),
			queryLocalFonts: typeof scope.queryLocalFonts,
		};
		if (typeof scope.queryLocalFonts === 'function')
			try {
				const local = await scope.queryLocalFonts();
				out.local = [local.length, tag(local)];
			} catch (error) {
				out.local = failure(error);
			}
		return out;
	});

	section('Intl', 'both', () => {
		const out = {};
		const locales = [
			'en-US',
			'fr',
			'zz',
			'de-DE-u-co-phonebk',
			'ja-JP-u-ca-japanese',
			'sr-Latn-RS',
			'tlh',
			'en-GB-oxendict',
			'zh-Hant-TW',
		];
		const first = {
			DisplayNames: [undefined, { type: 'region' }],
		};
		for (const name of Object.getOwnPropertyNames(Intl)) {
			const C = Intl[name];
			if (typeof C !== 'function' || !C.supportedLocalesOf) continue;
			const entry = {};
			try {
				entry.supported = C.supportedLocalesOf(locales);
				entry.lookup = C.supportedLocalesOf(locales, {
					localeMatcher: 'lookup',
				});
			} catch (error) {
				entry.supported = failure(error);
			}
			try {
				const options = new C(...(first[name] ?? [])).resolvedOptions();
				entry.resolved = [Object.keys(options).join(), options];
			} catch (error) {
				entry.resolved = failure(error);
			}
			out[name] = entry;
		}
		out.canonical = Intl.getCanonicalLocales(['EN-us', 'zh-hant-tw']);
		out.supportedValues = {};
		for (const key of [
			'calendar',
			'collation',
			'currency',
			'numberingSystem',
			'timeZone',
			'unit',
		]) {
			const values = Intl.supportedValuesOf(key);
			out.supportedValues[key] = [values.length, hash(values.join())];
		}
		out.date = [
			new Date(0).toString(),
			new Date(0).toLocaleString(),
			new Date(0).getTimezoneOffset(),
			(1234567.891).toLocaleString(),
			['b', 'a', 'ä', 'z', 'Z'].sort(new Intl.Collator().compare).join(),
		];
		return out;
	});

	section('matchMedia', 'document', () => {
		const out = {};
		for (const query of [
			'(prefers-color-scheme: dark)',
			'(prefers-color-scheme: light)',
			'(prefers-reduced-motion: reduce)',
			'(prefers-reduced-transparency: reduce)',
			'(prefers-reduced-data: reduce)',
			'(prefers-contrast: more)',
			'(prefers-contrast: no-preference)',
			'(forced-colors: active)',
			'(inverted-colors: inverted)',
			'(pointer: fine)',
			'(pointer: coarse)',
			'(pointer: none)',
			'(any-pointer: fine)',
			'(any-pointer: coarse)',
			'(hover: hover)',
			'(any-hover: hover)',
			'(display-mode: browser)',
			'(display-mode: standalone)',
			'(display-mode: fullscreen)',
			'(color-gamut: srgb)',
			'(color-gamut: p3)',
			'(color-gamut: rec2020)',
			'(dynamic-range: high)',
			'(video-dynamic-range: high)',
			'(monochrome)',
			'(color)',
			'(min-color: 8)',
			'(min-color: 10)',
			'(scripting: enabled)',
			'(update: fast)',
			'(overflow-block: scroll)',
			'(overflow-inline: scroll)',
			'(orientation: landscape)',
			'(orientation: portrait)',
			'(min-resolution: 1dppx)',
			'(min-resolution: 2dppx)',
			'(-webkit-min-device-pixel-ratio: 1)',
			'(device-posture: continuous)',
			'(horizontal-viewport-segments: 1)',
			'(display-state: normal)',
			'(resizable: true)',
			'print',
			'screen',
			'not all',
			'(nonsense-feature: 1)',
		]) {
			const list = matchMedia(query);
			out[query] = [list.matches, list.media];
		}
		// the features that name sizes, against what the window says
		out.relations = {
			width: matchMedia(`(width: ${innerWidth}px)`).matches,
			height: matchMedia(`(height: ${innerHeight}px)`).matches,
			deviceWidth: matchMedia(`(device-width: ${screen.width}px)`).matches,
			deviceHeight: matchMedia(`(device-height: ${screen.height}px)`).matches,
			resolution: matchMedia(`(resolution: ${devicePixelRatio}dppx)`).matches,
			aspect: matchMedia(`(aspect-ratio: ${innerWidth}/${innerHeight})`)
				.matches,
			deviceAspect: matchMedia(
				`(device-aspect-ratio: ${screen.width}/${screen.height})`,
			).matches,
			landscape:
				matchMedia('(orientation: landscape)').matches ===
				innerWidth >= innerHeight,
		};
		return out;
	});

	section('geometry', 'document', () => ({
		devicePixelRatio,
		// how the sizes relate: the sizes themselves are the window's, and
		// a proxied page's window is the host's frame for it
		relations: {
			'outer is at least inner, wide': outerWidth >= innerWidth,
			'outer is at least inner, tall': outerHeight >= innerHeight,
			'screen is at least available, wide': screen.width >= screen.availWidth,
			'screen is at least available, tall': screen.height >= screen.availHeight,
			'screenX is screenLeft': screenX === screenLeft,
			'screenY is screenTop': screenY === screenTop,
			'visual viewport is the layout viewport, wide':
				Math.round(visualViewport.width) ===
					document.documentElement.clientWidth ||
				Math.round(visualViewport.width) === innerWidth,
			'visual viewport is the layout viewport, tall':
				Math.round(visualViewport.height) ===
					document.documentElement.clientHeight ||
				Math.round(visualViewport.height) === innerHeight,
			'visual viewport is not zoomed': visualViewport.scale === 1,
			'visual viewport is at the origin':
				visualViewport.offsetLeft === 0 &&
				visualViewport.offsetTop === 0 &&
				visualViewport.pageLeft === 0 &&
				visualViewport.pageTop === 0,
			'the page is not scrolled': scrollX === 0 && scrollY === 0,
			'available origin is on the screen':
				screen.availLeft >= 0 && screen.availTop >= 0,
			'sizes are whole numbers': [
				innerWidth,
				innerHeight,
				outerWidth,
				outerHeight,
				screen.width,
				screen.height,
			].every(Number.isInteger),
		},
		screen: {
			colorDepth: screen.colorDepth,
			pixelDepth: screen.pixelDepth,
			isExtended: screen.isExtended,
			orientation: [screen.orientation.type, screen.orientation.angle],
			keys: Object.getOwnPropertyNames(Screen.prototype).join(),
		},
	}));

	section('navigator.storage.estimate', 'both', async () => {
		const estimate = await navigator.storage.estimate();
		return {
			keys: Object.keys(estimate).join(),
			types: Object.values(estimate)
				.map((value) => typeof value)
				.join(),
			quota: estimate.quota,
			details: estimate.usageDetails
				? Object.keys(estimate.usageDetails).join()
				: 'none',
			persisted: await navigator.storage.persisted(),
		};
	});

	const CODECS = [
		'video/mp4',
		'video/mp4; codecs="avc1.42E01E"',
		'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
		'video/mp4; codecs="avc1.640028"',
		'video/mp4; codecs="hev1.1.6.L93.B0"',
		'video/mp4; codecs="hvc1.1.6.L93.B0"',
		'video/mp4; codecs="av01.0.05M.08"',
		'video/mp4; codecs="vp09.00.10.08"',
		'video/mp4; codecs="mp4a.40.2"',
		'video/mp4; codecs="ac-3"',
		'video/mp4; codecs="ec-3"',
		'video/mp4; codecs="flac"',
		'video/mp4; codecs="opus"',
		'video/webm',
		'video/webm; codecs="vp8"',
		'video/webm; codecs="vp8, vorbis"',
		'video/webm; codecs="vp9"',
		'video/webm; codecs="vp09.00.10.08"',
		'video/webm; codecs="av01.0.05M.08"',
		'video/webm; codecs="opus"',
		'video/ogg',
		'video/ogg; codecs="theora"',
		'video/x-matroska; codecs="avc1.42E01E"',
		'video/quicktime',
		'video/3gpp',
		'video/mp2t; codecs="avc1.42E01E"',
		'application/vnd.apple.mpegurl',
		'application/x-mpegURL',
		'audio/mpeg',
		'audio/mp4; codecs="mp4a.40.2"',
		'audio/mp4; codecs="mp4a.40.5"',
		'audio/aac',
		'audio/ogg; codecs="vorbis"',
		'audio/ogg; codecs="opus"',
		'audio/ogg; codecs="flac"',
		'audio/webm; codecs="opus"',
		'audio/webm; codecs="vorbis"',
		'audio/wav',
		'audio/wav; codecs="1"',
		'audio/flac',
		'audio/x-m4a',
		'audio/midi',
		'',
		'nonsense',
	];
	section('codecs', 'both', async () => {
		const out = {};
		if (!inWorker) {
			const video = document.createElement('video');
			const audio = document.createElement('audio');
			out.canPlayType = CODECS.map((type) => [
				type,
				video.canPlayType(type),
				audio.canPlayType(type),
			]);
		}
		if (typeof MediaSource === 'function')
			out.isTypeSupported = CODECS.map((type) => [
				type,
				MediaSource.isTypeSupported(type),
			]);
		else out.isTypeSupported = 'no MediaSource';
		if (typeof scope.MediaRecorder === 'function')
			out.recorder = CODECS.map((type) => [
				type,
				MediaRecorder.isTypeSupported(type),
			]);
		const capabilities = navigator.mediaCapabilities;
		if (!capabilities) return { ...out, decodingInfo: 'no mediaCapabilities' };
		out.decodingInfo = {};
		for (const [label, configuration] of [
			[
				'file h264',
				{
					type: 'file',
					video: {
						contentType: 'video/mp4; codecs="avc1.42E01E"',
						width: 1920,
						height: 1080,
						bitrate: 2000000,
						framerate: 30,
					},
				},
			],
			[
				'media-source vp9',
				{
					type: 'media-source',
					video: {
						contentType: 'video/webm; codecs="vp09.00.10.08"',
						width: 3840,
						height: 2160,
						bitrate: 20000000,
						framerate: 60,
					},
				},
			],
			[
				'media-source av1',
				{
					type: 'media-source',
					video: {
						contentType: 'video/mp4; codecs="av01.0.05M.08"',
						width: 1280,
						height: 720,
						bitrate: 1000000,
						framerate: 24,
					},
				},
			],
			[
				'file hevc',
				{
					type: 'file',
					video: {
						contentType: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
						width: 1920,
						height: 1080,
						bitrate: 2000000,
						framerate: 30,
					},
				},
			],
			[
				'file opus',
				{
					type: 'file',
					audio: {
						contentType: 'audio/webm; codecs="opus"',
						channels: '2',
						bitrate: 128000,
						samplerate: 48000,
					},
				},
			],
			[
				'webrtc vp8',
				{
					type: 'webrtc',
					video: {
						contentType: 'video/VP8',
						width: 640,
						height: 480,
						bitrate: 500000,
						framerate: 30,
					},
				},
			],
			['nothing', { type: 'file' }],
			[
				'nonsense',
				{
					type: 'file',
					video: {
						contentType: 'nonsense',
						width: 1,
						height: 1,
						bitrate: 1,
						framerate: 1,
					},
				},
			],
		])
			try {
				const info = await capabilities.decodingInfo(configuration);
				out.decodingInfo[label] = [
					Object.keys(info).join(),
					info.supported,
					info.smooth,
					info.powerEfficient,
				];
			} catch (error) {
				out.decodingInfo[label] = failure(error);
			}
		return out;
	});

	section('RTCRtp capabilities', 'document', () => {
		const out = {};
		for (const [name, C] of [
			['sender', scope.RTCRtpSender],
			['receiver', scope.RTCRtpReceiver],
		])
			for (const kind of ['audio', 'video', 'nonsense']) {
				const capabilities = C.getCapabilities(kind);
				out[`${name} ${kind}`] = capabilities && {
					keys: Object.keys(capabilities).join(),
					codecs: capabilities.codecs.map(
						(codec) =>
							`${codec.mimeType} ${codec.clockRate} ${codec.channels ?? ''} ${codec.sdpFmtpLine ?? ''} [${Object.keys(codec).join()}]`,
					),
					headerExtensions: capabilities.headerExtensions.map(
						(extension) =>
							`${extension.uri} [${Object.keys(extension).join()}]`,
					),
				};
			}
		return out;
	});

	section('AudioContext', 'document', async () => {
		const out = {};
		try {
			const context = new AudioContext();
			out.context = {
				sampleRate: context.sampleRate,
				baseLatency: context.baseLatency,
				outputLatency: context.outputLatency,
				state: context.state,
				sinkId: context.sinkId,
				destination: [
					context.destination.maxChannelCount,
					context.destination.channelCount,
					context.destination.channelCountMode,
					context.destination.channelInterpretation,
					context.destination.numberOfInputs,
					context.destination.numberOfOutputs,
				],
				listener: tag(context.listener),
				renderQuantumSize: context.renderQuantumSize,
			};
			await context.close();
		} catch (error) {
			out.context = failure(error);
		}
		return out;
	});

	section('OfflineAudioContext render', 'document', async () => {
		// the readback fingerprinting scripts take: an oscillator through a
		// compressor, some of the rendered samples summed
		const context = new OfflineAudioContext(1, 5000, 44100);
		const oscillator = context.createOscillator();
		oscillator.type = 'triangle';
		oscillator.frequency.value = 1000;
		const compressor = context.createDynamicsCompressor();
		compressor.threshold.value = -50;
		compressor.knee.value = 40;
		compressor.ratio.value = 12;
		compressor.attack.value = 0;
		compressor.release.value = 0.2;
		oscillator.connect(compressor);
		compressor.connect(context.destination);
		oscillator.start(0);
		const buffer = await context.startRendering();
		const samples = buffer.getChannelData(0);
		let sum = 0;
		for (let i = 4500; i < 5000; i++) sum += Math.abs(samples[i]);
		const copied = new Float32Array(500);
		buffer.copyFromChannel(copied, 0, 4500);
		const analyser = context.createAnalyser();
		return {
			sum: String(sum),
			samples: hash(Array.from(samples.slice(4500, 4600)).join()),
			copied: hash(Array.from(copied.slice(0, 100)).join()),
			length: buffer.length,
			sampleRate: buffer.sampleRate,
			reduction: compressor.reduction,
			analyser: [
				analyser.fftSize,
				analyser.frequencyBinCount,
				analyser.minDecibels,
				analyser.maxDecibels,
				analyser.smoothingTimeConstant,
			],
		};
	});

	section('canvas 2d', 'both', async () => {
		const canvas = inWorker
			? new OffscreenCanvas(240, 60)
			: Object.assign(document.createElement('canvas'), {
					width: 240,
					height: 60,
				});
		const context = canvas.getContext('2d');
		const out = { metrics: {} };
		for (const font of [
			'16px serif',
			'16px sans-serif',
			'16px monospace',
			'italic bold 20px Arial',
			'13px "No Such Font Anywhere", cursive',
			'12px system-ui',
		]) {
			context.font = font;
			const metrics = context.measureText(
				'Cwm fjordbank glyphs vext quiz, \u{1F603}',
			);
			const values = {};
			for (const key of Object.getOwnPropertyNames(TextMetrics.prototype))
				if (key !== 'constructor' && typeof metrics[key] === 'number')
					values[key] = metrics[key];
			out.metrics[font] = [context.font, values];
		}
		context.textBaseline = 'top';
		context.font = '14px Arial';
		context.fillStyle = '#f60';
		context.fillRect(125, 1, 62, 20);
		context.fillStyle = '#069';
		context.fillText('Cwm fjordbank glyphs vext quiz, \u{1F603}', 2, 15);
		context.fillStyle = 'rgba(102, 204, 0, 0.7)';
		context.fillText('Cwm fjordbank glyphs vext quiz, \u{1F603}', 4, 17);
		const gradient = context.createLinearGradient(0, 0, 240, 60);
		gradient.addColorStop(0, 'red');
		gradient.addColorStop(1, 'blue');
		context.globalCompositeOperation = 'multiply';
		context.fillStyle = gradient;
		context.beginPath();
		context.arc(50, 40, 18, 0, Math.PI * 2);
		context.fill();
		const data = context.getImageData(0, 0, 240, 60);
		out.imageData = hash(Array.from(data.data).join());
		out.colorSpace = data.colorSpace;
		if (inWorker) {
			const blob = await canvas.convertToBlob();
			out.blob = [
				blob.type,
				hash(Array.from(new Uint8Array(await blob.arrayBuffer())).join()),
			];
		} else {
			out.dataURL = hash(canvas.toDataURL());
			out.jpeg = hash(canvas.toDataURL('image/jpeg', 0.5));
			out.webp = hash(canvas.toDataURL('image/webp', 0.5));
		}
		return out;
	});

	section('Notification', 'both', () =>
		typeof Notification === 'function'
			? {
					permission: Notification.permission,
					maxActions: Notification.maxActions,
				}
			: 'no Notification',
	);

	section('navigator.connection', 'both', () => {
		const connection = navigator.connection;
		if (!connection) return 'no connection';
		return {
			class: tag(connection),
			effectiveType: connection.effectiveType,
			rtt: connection.rtt,
			downlink: connection.downlink,
			saveData: connection.saveData,
			type: connection.type,
			downlinkMax: connection.downlinkMax,
			onLine: navigator.onLine,
		};
	});

	section('navigator.getBattery', 'document', async () => {
		if (!navigator.getBattery) return 'no getBattery';
		const battery = await navigator.getBattery();
		return {
			class: tag(battery),
			charging: battery.charging,
			chargingTime: String(battery.chargingTime),
			dischargingTime: String(battery.dischargingTime),
			level: battery.level,
			sameTwice: battery === (await navigator.getBattery()),
			samePromiseTwice: navigator.getBattery() === navigator.getBattery(),
		};
	});

	section('featurePolicy', 'document', () => {
		const policy = document.featurePolicy;
		if (!policy) return 'no featurePolicy';
		const allowed = policy.allowedFeatures();
		return {
			class: tag(policy),
			features: policy.features(),
			allowed,
			denied: policy.features().filter((name) => !allowed.includes(name)),
			allows: [
				'camera',
				'geolocation',
				'fullscreen',
				'sync-xhr',
				'nonsense',
			].map((name) => [name, policy.allowsFeature(name)]),
			allowlist: ['camera', 'fullscreen', 'sync-xhr'].map((name) => [
				name,
				policy.getAllowlistForFeature(name),
			]),
			permissionsPolicy: typeof document.permissionsPolicy,
		};
	});

	section('navigator', 'both', () => ({
		hardwareConcurrency: navigator.hardwareConcurrency,
		deviceMemory: navigator.deviceMemory,
		maxTouchPoints: navigator.maxTouchPoints,
		cookieEnabled: navigator.cookieEnabled,
		webdriver: navigator.webdriver,
		doNotTrack: navigator.doNotTrack,
		globalPrivacyControl: navigator.globalPrivacyControl,
		vendor: navigator.vendor,
		vendorSub: navigator.vendorSub,
		product: navigator.product,
		productSub: navigator.productSub,
		appName: navigator.appName,
		appCodeName: navigator.appCodeName,
		oscpu: navigator.oscpu,
		keys: (() => {
			const keys = [];
			for (const key in navigator) keys.push(key);
			return keys.join();
		})(),
	}));

	Reflect.defineProperty(scope, '__surfaceEnumeration', {
		configurable: true,
		enumerable: false,
		writable: true,
		value: async () => {
			const out = {};
			for (const name in sections)
				try {
					out[name] = await Promise.race([
						sections[name](),
						sleep(15000).then(() => 'no answer in 15 s'),
					]);
				} catch (error) {
					out[name] = failure(error);
				}
			return out;
		},
	});
	if (inWorker)
		scope.addEventListener('message', async () =>
			scope.postMessage(await scope.__surfaceEnumeration()),
		);
})();
