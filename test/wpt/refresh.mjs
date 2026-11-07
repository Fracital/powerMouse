// Copies the vendored subset of web-platform-tests from a checkout into this
// directory. The checkout is data: nothing in it is executed, files are read
// and copied. Everything not matched by INCLUDE (or matched by EXCLUDE) is
// left out; test/wpt/README.md explains each exclusion.
//
//   git clone --depth 1 --filter=blob:none --sparse \
//     https://github.com/web-platform-tests/wpt /tmp/wpt
//   git -C /tmp/wpt sparse-checkout set \
//     resources cookies fetch/metadata referrer-policy common
//   node test/wpt/refresh.mjs /tmp/wpt
//
// Then run the three wpt-* suites with UPDATE_EXPECTED=1 and review the
// expected-failure lists they rewrite.
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('./', import.meta.url));
const source = process.argv[2];
if (!source || !existsSync(join(source, 'resources/testharness.js'))) {
	console.error('usage: node test/wpt/refresh.mjs <path to a wpt checkout>');
	process.exit(2);
}

// the subresource kinds kept from the generated referrer-policy matrix; the
// shared-worker, SVG and MathML anchor variants add pages without adding a
// proxy code path
const REFERRER_SUBRESOURCES =
	'(a-tag|fetch|iframe-tag|img-tag|script-tag|script-tag-dynamic-import|worker-classic|worker-module|xhr)';

/** paths (relative to the checkout) to copy; a RegExp matches whole paths */
const INCLUDE = [
	'LICENSE.md',
	'resources/testharness.js',
	'resources/testdriver.js',
	'common/blank.html',
	'common/get-host-info.sub.js',
	'common/utils.js',
	'common/security-features/resources/common.sub.js',
	// cookies: everything document.cookie and Set-Cookie can show on one
	// http origin plus a same-site and a cross-site host
	/^cookies\/[^/]+\.(html|window\.js)$/,
	/^cookies\/(attributes|encoding|name|ordering|path|prefix|size|value)\/.*\.(html|js|headers)$/,
	/^cookies\/secure\/[^/]*\.sub\.html(\.headers)?$/,
	'cookies/resources/cookie-test.js',
	'cookies/resources/cookie-helper.sub.js',
	'cookies/resources/echo-cookie.html',
	'cookies/resources/testharness-helpers.js',
	'cookies/resources/navigate.html',
	// fetch metadata: the generated matrix (secure-context variants, since
	// localhost is a secure context) and the two fetch() lists
	/^fetch\/metadata\/generated\/[^/]+\.https\.sub(\.tentative)?\.html$/,
	'fetch/metadata/fetch.https.sub.any.js',
	'fetch/metadata/fetch-preflight.https.sub.any.js',
	'fetch/metadata/resources/helper.js',
	'fetch/metadata/resources/helper.sub.js',
	'fetch/metadata/resources/dedicatedWorker.js',
	'fetch/metadata/resources/es-module.sub.js',
	'fetch/metadata/resources/es-json-module.sub.js',
	'fetch/metadata/resources/es-text-module.sub.js',
	// referrer policy: the hand-written generic tests and the generated
	// top-level matrix (policy by header and by meta) for http sources
	/^referrer-policy\/generic\/[^/]+\.html(\.headers)?$/,
	/^referrer-policy\/generic\/(inheritance|subresource-test|resources)\/.*$/,
	'referrer-policy/generic/test-case.sub.js',
	'referrer-policy/generic/sanity-checker.js',
	new RegExp(
		`^referrer-policy/gen/(top\\.http-rp|top\\.meta|req\\.attr)/[^/]+/${REFERRER_SUBRESOURCES}\\.http\\.html(\\.headers)?$`,
	),
];

/** matched paths that still stay out */
const EXCLUDE = [
	// need https (secure-context cookie tests that must fail over http)
	/^cookies\/.*\.https\./,
	// a WebSocket handshake that sets a cookie: proxy-transports does not
	// expose those headers (CHANGELOG, Transport), and the missing wptserve
	// handler leaves the socket hanging until the budget runs out
	'cookies/secure/set-from-ws.sub.html',
	// wptserve python handlers; test/wpt-server.mjs ports the ones used
	/\.py$/,
	// a service worker, a worklet or an http-equiv refresh timer behind the
	// request: the proxy has no path for them to measure yet, and the
	// refresh ones are marked optional and wait seconds per case
	/^fetch\/metadata\/generated\/(serviceworker|fetch-via-serviceworker|audioworklet|element-link-prefetch|element-meta-refresh|header-refresh|header-link)/,
	// upgrade-insecure-requests needs an https origin to upgrade to
	/^referrer-policy\/generic\/iframe-upgrade-request-to-/,
	// a popup opened without user activation stays blocked in headless runs
	/^referrer-policy\/generic\/inheritance\/popup-/,
	// the generic worker inheritance test registers a service worker
	'referrer-policy/generic/inheritance/workers.html',
];

const matches = (rules, path) =>
	rules.some((rule) =>
		rule instanceof RegExp ? rule.test(path) : rule === path,
	);

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		if (name === '.git') continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) yield* walk(full);
		else yield full;
	}
}

// start over so a removed upstream file does not linger
for (const name of readdirSync(here)) {
	if (['refresh.mjs', 'README.md', 'expected', 'resources'].includes(name))
		continue;
	rmSync(join(here, name), { recursive: true });
}
for (const name of readdirSync(join(here, 'resources'))) {
	if (!['testharnessreport.js', 'testdriver-vendor.js'].includes(name))
		rmSync(join(here, 'resources', name));
}

const counts = new Map();
for (const full of walk(source)) {
	const path = relative(source, full).split('\\').join('/');
	if (!matches(INCLUDE, path) || matches(EXCLUDE, path)) continue;
	const target = join(here, path);
	mkdirSync(dirname(target), { recursive: true });
	copyFileSync(full, target);
	const top = path.split('/').slice(0, 2).join('/');
	counts.set(top, (counts.get(top) || 0) + 1);
}

// the upstream commit, read from the checkout's own metadata
let commit = 'unknown';
try {
	const head = readFileSync(join(source, '.git/HEAD'), 'utf8').trim();
	commit = head.startsWith('ref: ')
		? readFileSync(join(source, '.git', head.slice(5)), 'utf8').trim()
		: head;
} catch {
	// a checkout without .git: the caller records the commit by hand
}
console.log(`web-platform-tests ${commit}`);
let total = 0;
for (const [dir, count] of [...counts].sort()) {
	console.log(`${String(count).padStart(5)}  ${dir}`);
	total += count;
}
console.log(`${String(total).padStart(5)}  files`);
