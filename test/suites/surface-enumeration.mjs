// What the platform lists and measures for a page, natively and through the
// proxy (test/pages/surface-enumeration.html, whose script is loaded as an
// ordinary script so the proxy rewrites it like any page code): media
// devices, speech voices, WebGL and WebGPU extensions, parameters and
// limits, plugins and MIME types, languages, client hints (the order of the
// values asked for), permission states, gamepads, the keyboard layout,
// fonts, Intl locales and options, media queries, how the window's sizes
// relate, storage, codecs, RTP capabilities, audio and canvas readbacks,
// the connection, the battery and the feature policy. Each is read in the
// top document, in a frame of the same page and (what exists there) in a
// worker, and every value, count and order must be the native one, in both
// demo modes. A value that differs between two native loads is compared by
// its type; EXCLUDED lists what else is left out, each with its reason.
//
// Twice: with software GL and Chrome's fake media devices, and with no
// device and the machine's own GL. A machine without a GPU, a voice or a
// device (a CI runner) answers "no context", an empty list or its own
// error natively, and the proxied page must answer the same: nothing is
// skipped, the native answer is the expectation whatever it is.
//
// SURFACE_ENUMERATION_DUMP=<directory> writes every record.
import { mkdirSync, writeFileSync } from 'node:fs';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	NO_AUDIO,
	ok,
	PROXY,
	sleep,
	SLOT_PORTS,
	submitLanding,
	waitForServer,
} from '../lib.mjs';

const DUMP = process.env.SURFACE_ENUMERATION_DUMP;
const target = `${FIXTURE}pages/surface-enumeration.html`;

// What is not compared: [realm pattern, path pattern, reason, mode]. One
// marked OPEN is a difference the proxy makes and has yet to unmake.
const EXCLUDED = [
	[
		/./,
		/^navigator\.connection\.(downlink|rtt)$/,
		"the browser's estimate of the network, which moves between loads",
	],
	[
		/./,
		/^webgpu\.wgslLanguageFeatures\./,
		'a set the browser lists in an order of its own in each realm: natively a document, its frame and its worker each list it differently',
	],
	[
		/./,
		/^navigator\.permissions\.query\.(background-fetch|local-fonts)\.0$/,
		"OPEN: the state of a permission the inject does not keep for the site is the browser's for the proxy's frame (background-fetch: prompt where a page of its own is granted), and local-fonts reads prompt in a frame and a worker where the browser says denied",
	],
	[
		/^(document|frame)$/,
		/^featurePolicy\.(allowed|denied|allows|allowlist)/,
		"OPEN: the isolated demo host's frame is another origin's, with the features its allow attribute delegates and no more",
		'isolated',
	],
	[
		/^(document|frame)$/,
		/^navigator\.keyboard\.getLayoutMap/,
		"OPEN: the isolated demo host's frame is not delegated keyboard-map, and the inject answers an empty Map where the browser refuses",
		'isolated',
	],
	[
		/^(document|frame)$/,
		/^webgl2?\.attributes\.powerPreference$/,
		"OPEN: Chrome gives a frame of another origin than its top the low-power GPU, which the isolated demo host's frame is",
		'isolated',
	],
	// the site pool (docs/site-pool.md) shows the same-origin page's sites
	// from a slot, another origin than the host's
	...(SLOT_PORTS.length
		? [
				[
					/^(document|frame)$/,
					/^webgl2?\.attributes\.powerPreference$/,
					"OPEN: Chrome gives a frame of another origin than its top the low-power GPU, which a site pool slot's frame is",
					'same-origin',
				],
			]
		: []),
];

// OPEN (Chrome 158 and later): a frame under the proxied top lacks
// focus-without-user-activation, which natively it has. A sandboxed frame and
// every frame under it lack the feature unless the frame's own allow names
// it; the controller names it on the frame it sandboxes (allowWithFocus,
// src/controller/remote.ts), not on the frames the page makes. The lists are
// compared by index, so the name alone goes out of the frame's
// featurePolicy (allowed natively, denied through the proxy) where that is
// how it differs. A proxied frame that has it again is compared as it is;
// permissions-policy's count of the frames that lack it fails then, and
// this goes with its entry
const OPEN_FOCUS = 'focus-without-user-activation';
const OPEN_FOCUS_REASON = `OPEN: Chrome 158 and later: ${OPEN_FOCUS} in a frame under the proxied top, which the host frame's sandbox turns off`;
/** a frame's featurePolicy records with OPEN_FOCUS out, or null where it is not how they differ */
function withoutOpenFocus(major, realm, section, records) {
	if (major < 158 || realm !== 'frame' || section !== 'featurePolicy')
		return null;
	const [first, second, proxied] = records;
	if (
		![first, second].every((record) => record?.allowed?.includes(OPEN_FOCUS)) ||
		!proxied?.denied?.includes(OPEN_FOCUS)
	)
		return null;
	const drop = (record) => ({
		...record,
		allowed: record.allowed.filter((name) => name !== OPEN_FOCUS),
		denied: record.denied?.filter((name) => name !== OPEN_FOCUS),
	});
	return [drop(first), drop(second), drop(proxied)];
}

const CONFIGURATIONS = [
	{
		name: 'software GL, fake devices',
		args: [
			'--use-gl=angle',
			'--use-angle=swiftshader',
			'--enable-unsafe-swiftshader',
			'--use-fake-device-for-media-stream',
		],
		env: null,
	},
	{
		name: 'no device',
		args: ['--use-fake-device-for-media-stream=device-count=0'],
		env: NO_AUDIO,
	},
];

async function record(find) {
	for (let i = 0; i < 1200; i++) {
		await sleep(250);
		const text = await (
			await find()
		)
			?.evaluate(() =>
				window.__surfaceEnumerationRecord?.done
					? JSON.stringify(window.__surfaceEnumerationRecord.record)
					: null,
			)
			.catch(() => null);
		if (text) return JSON.parse(text);
	}
	return null;
}

/** every leaf of a value by its path */
function leaves(value, path, out) {
	if (value !== null && typeof value === 'object') {
		const keys = Object.keys(value);
		// the order of an object's keys is a fact of its own
		if (!Array.isArray(value)) out.set(`${path} (keys)`, keys.join(','));
		else out.set(`${path} (length)`, value.length);
		for (const key of keys) leaves(value[key], `${path}.${key}`, out);
	} else out.set(path, value);
	return out;
}

const show = (value) => String(JSON.stringify(value)).slice(0, 200);

for (const configuration of CONFIGURATIONS) {
	const browser = await launch(configuration.args, { env: configuration.env });
	const major = Number(browser.version().split('.')[0]);
	const native = async () => {
		const context = await browser.newContext({ viewport: null });
		const page = await context.newPage();
		await page.goto(target);
		const result = await record(async () => page.mainFrame());
		await context.close();
		return result;
	};
	const through = async (base) => {
		await waitForServer(base);
		const context = await browser.newContext({ viewport: null });
		const page = await context.newPage();
		await page.goto(base);
		await page.waitForFunction(
			() =>
				/^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
			null,
			{ timeout: 45000 },
		);
		await submitLanding(page, target);
		const result = await record(async () =>
			page.frames().find((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())),
		);
		await context.close();
		return result;
	};
	const MODES = [
		['same-origin', PROXY],
		['isolated', HOST],
	];
	const [first, second, ...proxied] = await Promise.all([
		native(),
		native(),
		...MODES.map(([, base]) => through(base)),
	]);
	if (DUMP) {
		mkdirSync(DUMP, { recursive: true });
		const slug = configuration.name.replace(/\W+/g, '-');
		writeFileSync(`${DUMP}/${slug}-native1.json`, JSON.stringify(first));
		writeFileSync(`${DUMP}/${slug}-native2.json`, JSON.stringify(second));
		MODES.forEach(([mode], index) =>
			writeFileSync(
				`${DUMP}/${slug}-${mode}.json`,
				JSON.stringify(proxied[index]),
			),
		);
	}
	if (
		!ok(
			`${configuration.name}: natively, the page reads everything`,
			!!first && !!second,
		)
	) {
		await browser.close();
		continue;
	}
	// what this machine has, for whoever reads the log
	console.log(
		`NOTE ${configuration.name}: natively ${first.document.webgl === 'no context' ? 'no WebGL context' : `WebGL with ${first.document.webgl?.extensions?.length} extensions`}, ` +
			`${first.document['speechSynthesis.getVoices']?.later?.length ?? 'no'} voices, ` +
			`${first.document['mediaDevices.enumerateDevices']?.length ?? 'no'} media devices, ` +
			`WebGPU adapter ${first.document.webgpu?.info ? 'present' : 'absent'}`,
	);
	for (const [index, [mode]] of MODES.entries()) {
		const reached = proxied[index];
		if (
			!ok(
				`${configuration.name}: ${mode}: the page reads everything through the proxy`,
				!!reached,
			)
		)
			continue;
		for (const realm of ['document', 'frame', 'worker']) {
			const a = first[realm];
			const b = second[realm];
			const p = reached[realm];
			if (typeof a !== 'object' || a === null) {
				console.log(
					`SKIP ${configuration.name}: ${mode}: ${realm}: no native record (${show(a)})`,
				);
				continue;
			}
			for (const section of Object.keys(a)) {
				const open = withoutOpenFocus(major, realm, section, [
					a[section],
					b?.[section],
					p?.[section],
				]);
				const [aSection, bSection, pSection] = open ?? [
					a[section],
					b?.[section],
					p?.[section],
				];
				const natively = leaves(aSection, section, new Map());
				const again = leaves(bSection, section, new Map());
				const got = leaves(pSection, section, new Map());
				const differences = [];
				let volatile = 0;
				const left = new Map();
				if (open) left.set(OPEN_FOCUS_REASON, 1);
				const differ = (path, x, y) => {
					const rule = EXCLUDED.find(
						([realms, pattern, , only]) =>
							realms.test(realm) &&
							pattern.test(path) &&
							(!only || only === mode),
					);
					if (rule) left.set(rule[2], (left.get(rule[2]) ?? 0) + 1);
					else differences.push(`${path}: ${show(x)} -> ${show(y)}`);
				};
				for (const [path, value] of natively) {
					if (again.get(path) !== value) {
						// not the same natively twice: its type is what holds
						volatile++;
						if (typeof got.get(path) !== typeof value)
							differ(path, `(a ${typeof value})`, got.get(path));
						continue;
					}
					if (got.get(path) !== value) differ(path, value, got.get(path));
				}
				for (const [path, value] of got)
					if (!natively.has(path) && !again.has(path))
						differ(path, undefined, value);
				ok(
					`${configuration.name}: ${mode}: ${realm}: ${section} is as natively`,
					differences.length === 0,
					`${natively.size} values` +
						`${volatile ? `, ${volatile} that change natively compared by type` : ''}` +
						[...left]
							.map(([reason, count]) => `, ${count} left out (${reason})`)
							.join('') +
						(differences.length
							? `; ${differences.length} differ: ${differences.slice(0, 10).join(' | ')}`
							: ''),
				);
			}
		}
	}
	await browser.close();
}
await done(null);
