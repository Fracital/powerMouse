// The hosts a page's own Content-Security-Policy names are its real
// origin's and the sites it names, as natively (test/csp-server.mjs,
// test/pages/csp-probes.js): every routed load is the proxy origin's to the
// browser, so the service worker refuses a request of a document whose
// policy refuses its real URL (connect-src, img-src, font-src, media-src,
// worker-src), and the inject refuses what no worker sees (a frame, an
// object, a WebSocket). The browser still refuses and reports each one: the
// violation is its own, trusted, and names the page's URL and policy as
// natively (a redirect's first URL, a frame of another origin by its
// origin). A policy that allows the load natively reports nothing of
// another's refusal. Compared with the page loaded natively, in both modes.
import { compareCases, OTHER } from '../csp-lib.mjs';
import { done, launch } from '../lib.mjs';

const other = OTHER.replace(/\/$/, '');
const otherHost = new URL(OTHER).host;

const CASES = {
	connect: {
		p: "connect-src 'self'",
		probes: [
			'fetch-self',
			'fetch-other',
			'fetch-other-path',
			'fetch-redirect-self',
			'fetch-redirect-other',
			'xhr-self',
			'xhr-other',
			'es-self',
			'ws-other',
			'beacon-other',
		],
	},
	'connect to the other host': {
		p: `connect-src 'self' ${other}`,
		probes: ['fetch-other', 'xhr-other', 'fetch-redirect-other', 'ws-other'],
	},
	'connect by host and wildcard port': {
		p: `connect-src ${otherHost.replace(/:\d+$/, ':*')}`,
		probes: ['fetch-self', 'fetch-other', 'ws-other'],
	},
	'connect by path': {
		p: `connect-src 'self' ${other}/csp/ok`,
		probes: ['fetch-other', 'fetch-other-path', 'fetch-redirect-other'],
	},
	images: {
		p: "img-src 'self'",
		probes: [
			'img-self',
			'img-other',
			'img-redirect-other',
			'img-other-redirect-self',
		],
	},
	'images by scheme': {
		p: 'img-src http:',
		probes: ['img-self', 'img-other', 'img-data'],
	},
	'default-src self': {
		p: "default-src 'self'; script-src 'self' 'unsafe-inline'",
		probes: [
			'font-self',
			'font-other',
			'media-self',
			'media-other',
			'object-self',
			'object-other',
			'frame-self',
			'frame-other',
			'frame-other-path',
		],
	},
	'frames of the other host': {
		p: `frame-src ${other}`,
		probes: ['frame-self', 'frame-other', 'frame-other-path'],
	},
	'two policies': {
		p: [`connect-src 'self' ${other}`, "connect-src 'self'"],
		probes: ['fetch-self', 'fetch-other', 'ws-other'],
	},
	'report-only': {
		ro: "connect-src 'self'; img-src 'self'; frame-src 'self'",
		probes: [
			'fetch-other',
			'xhr-other',
			'img-other',
			'frame-other',
			'ws-other',
		],
	},
	'enforced and report-only': {
		p: "img-src 'self'",
		ro: `img-src 'self' ${other}`,
		probes: ['img-self', 'img-other'],
	},
};

const browser = await launch();
await compareCases(browser, CASES);
await done(browser);
