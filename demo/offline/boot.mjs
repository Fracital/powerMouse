// The offline-html build's first script (scripts/build-offline.mjs): the
// demo's config, then its files decoded and the page's side installed
// (./host.mjs) before the demo's main.js asks for the controller
// (`STOMP_OFFLINE.ready`).
/* global __PM_PRELUDE__, __PM_ADBLOCK__, __PM_BUILD__, __PM_COMMITS__ */
import { createFrame, install, ORIGIN } from './host.mjs';

const WISP_KEY = 'stomp-demo:wisp';
const query = new URLSearchParams(location.search);
function readSaved() {
	const entry = history.state?.[WISP_KEY];
	if (typeof entry === 'string') return entry || null;
	try {
		return localStorage.getItem(WISP_KEY);
	} catch {
		return null;
	}
}
const saved = readSaved();
// the wisp server the file was made with, at the top of its head
// (scripts/build-offline.mjs WISP_SLOT), which the demo's Download button
// rewrites to the wisp server of the page it is saved from
const builtIn = JSON.parse(document.getElementById('pm-wisp').textContent);
const wisp = query.get('wisp') || saved || builtIn;

// what the demo's server would render as /config.js
globalThis.STOMP_CONFIG = {
	wisp,
	http3: true,
	echDns: 'https://cloudflare-dns.com/dns-query',
	shieldsDefaults: true,
	webTransport: true,
	transports: { epoxy: `${ORIGIN}/epoxy/`, libcurl: `${ORIGIN}/libcurl/` },
	...(__PM_ADBLOCK__ ? {} : { adblock: false }),
};

/** each file of the payload, gunzipped (a file kept as it is when it says so) */
async function decode() {
	const payload = JSON.parse(document.getElementById('pm-files').textContent);
	const decoded = new Map();
	await Promise.all(
		Object.entries(payload).map(async ([path, [type, coding, data]]) => {
			const bytes = Uint8Array.fromBase64(data);
			const plain =
				coding === 'gzip'
					? await new Response(
							new Blob([bytes])
								.stream()
								.pipeThrough(new DecompressionStream('gzip')),
						).blob()
					: bytes;
			decoded.set(path, new Blob([plain], { type }));
		}),
	);
	return decoded;
}

// what the demo's server answers itself: its status (this page's age as
// its uptime, the build it was made of) and the commits it was made from
const started = Date.now();
const json = (value, status = 200) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' },
	});
const answers = new Map([
	[
		'/api/status',
		() =>
			json({
				uptime: (Date.now() - started) / 1000,
				version: __PM_BUILD__.version,
				build: __PM_BUILD__,
			}),
	],
	[
		'/api/commits',
		() =>
			__PM_COMMITS__
				? json(__PM_COMMITS__)
				: json({ error: 'offline.html was built without git' }, 502),
	],
]);

const ready = install({ decoded: decode(), prelude: __PM_PRELUDE__, answers });
ready.catch((error) => console.error('STomp offline.html:', error));

globalThis.STOMP_OFFLINE = {
	origin: ORIGIN,
	/** resolves with the stand-in for the service worker the controller is given */
	ready,
	createFrame,
	/** what the controller is given beside the demo's own options */
	controllerInit: {
		// no SharedWorker (a file: page's cannot start), no worker of the
		// controller's to rewrite in, no emulated service workers for pages
		carrierHost: false,
		rewriteWorkers: 0,
		serviceWorkers: false,
	},
	/** the transport runs in this page (its modules are mapped here only) */
	transportHost: 'page',
	wisp: {
		current: wisp,
		builtIn,
		saved,
		/** keep `url` (empty: the built-in one) and start again with it */
		save(url) {
			const next = new URL(location.href);
			next.searchParams.delete('wisp');
			// Chrome can reopen a file before its localStorage write is visible.
			// Keep the choice in this history entry, not in the URL.
			history.replaceState({ ...history.state, [WISP_KEY]: url }, '', next);
			try {
				if (url) localStorage.setItem(WISP_KEY, url);
				else localStorage.removeItem(WISP_KEY);
			} catch {
				// no persistent storage: this history entry still has the choice
			}
			location.reload();
		},
	},
};
