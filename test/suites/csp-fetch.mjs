// A page's own Content-Security-Policy refuses what natively it refuses
// (test/csp-server.mjs, test/pages/csp-probes.js): each case is a page under
// policies of its headers (enforced, report-only, several) or its metas,
// whose probes try loads its fetch directives govern (connect-src, img-src,
// font-src, media-src, object-src, frame-src and child-src, worker-src)
// from `data:` and `blob:` URLs and from the page's own origin, and record
// what each did and the securitypolicyviolation events the document saw
// (the directive, the blocked URI, the page's policy as it wrote it, the
// document's URL). Compared with the page loaded natively, in both modes.
// The proxy used to strip every policy: Cloudflare's challenge expects
// `fetch('data:,')` to be refused (its connect-src), and it went through.
import { compareCases } from '../csp-lib.mjs';
import { done, launch, ok } from '../lib.mjs';

const CASES = {
	// no policy: what the probes do through the proxy without one
	'no policy': {
		probes: [
			'fetch-data',
			'fetch-blob',
			'img-data',
			'img-blob',
			'object-data',
			'frame-data',
			'frame-blob',
			'worker-blob',
			'worker-data',
		],
	},
	// Cloudflare's challenge frame's shape
	turnstile: {
		p: "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; worker-src blob:; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-src 'self' blob:; child-src 'self' blob:",
		probes: [
			'fetch-data',
			'fetch-blob',
			'fetch-self',
			'xhr-data',
			'xhr-sync-data',
			'xhr-blob',
			'xhr-self',
			'img-data',
			'img-blob',
			'img-self',
			'frame-self',
			'frame-blob',
			'frame-data',
			'worker-blob',
			'worker-data',
		],
	},
	// the full kits4beats/Cloudflare shape: the turnstile policy AND a
	// Permissions-Policy of sync-xhr=(). A proxied fetch('data:,')/blob: the
	// connect-src refuses must be refused by the browser's connect-src exactly
	// as natively, never routed through the sync bridge (which the proxy
	// origin's sync-xhr=() would then refuse as a "disabled by permissions
	// policy" error instead); src/inject/dom/Client.ts connectRefusal fetches
	// a local-scheme URL as written, asynchronously.
	'turnstile-pp': {
		p: "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; worker-src blob:; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-src 'self' blob:; child-src 'self' blob:",
		pp: 'sync-xhr=()',
		probes: [
			'fetch-data',
			'fetch-blob',
			'fetch-self',
			'xhr-sync-data',
			'img-data',
			'img-self',
		],
	},
	none: {
		p: "default-src 'none'; script-src 'self' 'unsafe-inline'",
		probes: [
			'fetch-data',
			'fetch-blob',
			'img-data',
			'img-blob',
			'media-blob',
			'object-data',
			'frame-data',
			'frame-blob',
			'frame-srcdoc',
			'worker-blob',
			'worker-data',
		],
	},
	self: {
		p: "default-src 'self'; script-src 'self' 'unsafe-inline'",
		probes: [
			'fetch-data',
			'fetch-blob',
			'fetch-self',
			'img-data',
			'img-blob',
			'img-self',
			'font-self',
			'media-self',
			'media-blob',
			'object-self',
			'object-data',
			'frame-self',
			'frame-data',
			'frame-blob',
			'frame-srcdoc',
			'worker-self',
			'worker-blob',
			'worker-data',
		],
	},
	schemes: {
		p: "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' blob: data:",
		probes: [
			'fetch-data',
			'fetch-blob',
			'img-data',
			'img-blob',
			'media-blob',
			'object-data',
			'frame-data',
			'frame-blob',
			'worker-blob',
			'worker-data',
		],
	},
	star: {
		p: 'img-src *; connect-src *',
		probes: [
			'fetch-data',
			'fetch-blob',
			'fetch-self',
			'fetch-other',
			'img-data',
			'img-blob',
			'img-self',
			'img-other',
		],
	},
	meta: {
		m: "connect-src 'self'; img-src 'self' data:",
		probes: ['fetch-data', 'fetch-blob', 'fetch-self', 'img-data', 'img-blob'],
	},
	'report-only': {
		ro: "connect-src 'self'; img-src 'self'",
		probes: ['fetch-data', 'fetch-self', 'img-data', 'img-blob', 'img-self'],
	},
	'two policies': {
		p: ["connect-src 'self' data:", "connect-src 'self' blob:"],
		probes: ['fetch-data', 'fetch-blob', 'fetch-self'],
	},
	'header and meta': {
		p: "img-src 'self' data: blob:",
		m: "img-src 'self' blob:",
		probes: ['img-data', 'img-blob', 'img-self'],
	},
	'child-src': {
		p: "child-src 'self'",
		probes: ['frame-self', 'frame-blob', 'worker-self', 'worker-blob'],
	},
	'worker-src from script-src': {
		p: "script-src 'self' 'unsafe-inline'",
		probes: ['worker-self', 'worker-blob', 'worker-data'],
	},
};

const browser = await launch();
const native = await compareCases(browser, CASES);
ok(
	"natively, a data: fetch is refused under Cloudflare's policy",
	native.turnstile?.results['fetch-data'] === 'TypeError: Failed to fetch' &&
		native.turnstile.events.some(
			(event) =>
				event.blockedURI === 'data' &&
				event.effectiveDirective === 'connect-src',
		),
	JSON.stringify(native.turnstile?.results),
);
ok(
	"natively, a data: fetch is refused by connect-src under both the CSP and sync-xhr=()",
	native['turnstile-pp']?.results['fetch-data'] ===
		'TypeError: Failed to fetch' &&
		native['turnstile-pp'].events.some(
			(event) =>
				event.blockedURI === 'data' &&
				event.effectiveDirective === 'connect-src',
		),
	JSON.stringify(native['turnstile-pp']?.results),
);
await done(browser);
