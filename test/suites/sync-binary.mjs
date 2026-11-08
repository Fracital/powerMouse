// Synchronous requests carry response bodies byte for byte, as the browser
// would: a sync XHR in a window with overrideMimeType('text/plain;
// charset=x-user-defined') (the classic way to read binary synchronously)
// reads every byte from 0x00 to 0xFF, a Latin-1 text decodes with its header
// charset, a UTF-8 text keeps the characters past U+00FF, a dedicated
// worker's sync XHR gives the same bytes as an ArrayBuffer and a Blob, and a
// UTF-8 script written into a document no service worker controls (copied
// through the synchronous bridge) runs with its text intact. An ArrayBuffer
// or Uint8Array request body goes out byte for byte. The reported
// status, URL and headers match too, and async XHR and fetch read the same
// files as the browser does. Every value is compared with the page loaded
// straight from the fixture; both demo modes.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const target = `${FIXTURE}pages/sync-binary.html`;
const RAMP = Array.from({ length: 256 }, (_, i) =>
	i.toString(16).padStart(2, '0'),
);
const BYTES = [...RAMP, ...RAMP.slice().reverse()].join('');

const GROUPS = {
	'a window sync XHR with the x-user-defined charset reads every byte': [
		'syncUserDefined',
		'syncLatin1UserDefined',
	],
	'a window sync XHR decodes Latin-1 and UTF-8 text as the browser does': [
		'syncLatin1',
		'syncUtf8',
		'syncBinaryText',
	],
	'a window sync XHR sends an ArrayBuffer and a Uint8Array body byte for byte':
		['syncPostBuffer', 'syncPostView'],
	'a window refuses a response type on a sync XHR as the browser does': [
		'syncArrayBufferInWindow',
	],
	'a worker sync XHR gives the bytes as an ArrayBuffer and a Blob': [
		'worker.arraybuffer',
		'worker.blob',
	],
	'a worker sync XHR decodes x-user-defined, Latin-1 and UTF-8 text': [
		'worker.userDefined',
		'worker.latin1',
		'worker.utf8',
	],
	'a UTF-8 script written into an uncontrolled document keeps its text': [
		'writtenScript',
	],
	'async XHR reads the same bytes and text as the browser': [
		'asyncArrayBuffer',
		'asyncUserDefined',
		'asyncLatin1',
		'asyncUtf8',
		'asyncBlob',
	],
	'fetch reads the same bytes and text as the browser': [
		'fetchBinary',
		'fetchLatin1',
	],
};

const pick = (value, path) =>
	path.split('.').reduce((at, key) => at?.[key], value);

async function report(page) {
	for (let i = 0; i < 240; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__syncBinary)
				.catch(() => null);
			if (value?.done) return value;
		}
	}
	return null;
}

const strip = (value) => JSON.stringify(value ?? null);

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await report(nativePage);
await nativePage.close();
ok(
	'natively, the fixture reads every byte (sanity)',
	native?.syncUserDefined?.bytes === BYTES &&
		native?.worker?.arraybuffer?.bytes === BYTES &&
		native?.writtenScript?.ran === 'string',
	JSON.stringify(native)?.slice(0, 400),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await report(page);
	ok(`${mode}: the page reports through the proxy`, !!proxied?.done);
	if (!native || !proxied) {
		await page.close();
		continue;
	}
	for (const [name, keys] of Object.entries(GROUPS)) {
		const differ = keys.filter(
			(key) => strip(pick(native, key)) !== strip(pick(proxied, key)),
		);
		ok(
			`${mode}: ${name}`,
			differ.length === 0,
			JSON.stringify(
				Object.fromEntries(
					differ.map((key) => [
						key,
						{ native: pick(native, key), proxied: pick(proxied, key) },
					]),
				),
			),
		);
	}
	await page.close();
}
await done(browser);
