// Shared runner for the adversarial-<group> suites: scramjet's adversarial
// corpus (packages/runway/src/tests/adversarial, eval.ts, llm/escapes.ts)
// ported as a measurement. Each group is a fixture page,
// test/pages/adv-<group>.html, whose probes run inside the proxied page and
// report what they saw; this runner loads the page in both demo modes
// (same-origin controller on 127.0.0.1, isolated host on localhost) and calls
// a probe a leak when its value shows the host window or document, the demo
// origin, a /stomp/ URL, an inject global, or a fingerprint the page marked
// TELL:/LEAK:. It also checks the host page itself was not touched (the
// same document, at the same address but for the token of the tab's entry
// the demo writes there itself, its title, a marker property, messages
// posted at it), and prints a BYPASS:
// line (outside the counts) for every request that reached the network
// without the proxy. Nothing here fixes
// anything: a leak is a FAIL line that names the probe and the value, so the
// parity doc can carry it.
//
// The suites gate CI. Each one lists its open cases (`knownOpen`): a listed
// check that still fails passes as "known open", one that passes again fails
// (the entry is stale and goes, with the parity doc's line), and a failure
// that is not listed fails the suite.
//
// This file is a library. Run by test/run.mjs it prints nothing and exits 0.
import {
	done,
	FIXTURE,
	HOST,
	hostPage,
	launch,
	ok,
	openDemo,
	PORT,
	PROXY,
	recordRequests,
	sleep,
	submitLanding,
} from './lib.mjs';

// scramjet's own expected failures (packages/runway/failing_tests.json), the
// subset the adv-* probes map onto; a leaking probe whose scramjet twin is
// listed here is annotated "scramjet also fails"
export const SCRAMJET_FAILS = new Set([
	'cachestorage-add-and-addall',
	'cachestorage-keys-not-namespaced',
	'cachestorage-request-keys-urls',
	'cssurls-author-string-preserved',
	'cssurls-computed-style',
	'cssurls-cssom-write-serialization',
	'cssurls-cssrule-style-property',
	'domattr-attributes-namednodemap',
	'domattr-integrity-property',
	'domattr-mutationobserver-records',
	'domattr-selector-literal-value',
	'domattr-shadow-innerhtml-urls',
	'elurls-anchor-component-setters',
	'elurls-svg-use-baseval',
	'elurls-unproxied-properties',
	'escapes-document-parsehtmlunsafe-static-img-onerror',
	'escapes-domparser-xhtml-img-onerror',
	'escapes-object-assign-window-location-javascript',
	'escapes-postmessage-source-eval',
	'escapes-reflect-set-document-location-javascript',
	'escapes-reflect-set-location-javascript',
	'escapes-script-append-string',
	'escapes-script-appendchild-textnode',
	'escapes-script-insertadjacenttext',
	'escapes-script-prepend-string',
	'escapes-script-replacechildren-string',
	'escapes-script-text',
	'escapes-script-textnode-appenddata',
	'escapes-script-textnode-data',
	'escapes-script-textnode-insertdata',
	'escapes-script-textnode-nodevalue',
	'escapes-script-textnode-replacedata',
	'escapes-script-textnode-textcontent',
	'escapes-setattribute-onclick',
	'escapes-setattributenode-iframe-srcdoc',
	'escapes-setattributenode-onclick',
	'escapes-setattributenode-script-src-data',
	'escapes-setattributens-onclick',
	'escapes-setnameditem-iframe-srcdoc',
	'escapes-setnameditem-onclick',
	'escapes-setnameditem-script-src-data',
	'escapes-shadowroot-innerhtml-onerror',
	'escapes-shadowroot-sethtmlunsafe-onerror',
	'escapes-svg-script-setattributens-href-data',
	'escapes-svg-script-textcontent',
	'escapes-xhr-response-document-html-img-onerror',
	'escapes-xhr-response-document-xhtml-img-onerror',
	'escapes-xhr-responsexml-xhtml-img-onerror',
	'escapes-xslt-transformtodocument-img-onerror',
	'escapes-xslt-transformtofragment-img-onerror',
	'eval-callee-comment',
	'eval-callee-whitespace',
	'eval-delete-property',
	'eval-gopd-leak',
	'eval-overwritten-global',
	'eval-parenthesized-is-direct',
	'eval-reflect-get-leak',
	'eval-shadowed-binding',
	'functionctor-async-flavor',
	'functionctor-asyncgenerator-flavor',
	'functionctor-generator-flavor',
	'functionctor-prototype-constructor-identity',
	'location-ancestororigins',
	'location-own-property-names',
	'longtail-api-performance-getentriesbyname-author-url',
	'longtail-api-performance-navigation-tojson-name',
	'longtail-api-performance-resource-tojson-name',
	'longtail-api-performance-user-mark-masked-name',
	'longtail-api-typed-om-background-image-readback',
	'modules-importmap',
	'originisolation-cross-site-frame-access',
	'platform-error-stack-urls',
	'platform-indexeddb-databases',
	'platform-navigator-serviceworker',
	'platform-objecturl-revoke',
	'platform-resource-timing-no-proxy-internals',
	'pmwrap-delete',
	'pmwrap-detached-loses-receiver',
	'pmwrap-function-shape',
	'pmwrap-getter-invocation-count',
	'pmwrap-identity',
	'pmwrap-prototype-method',
	'serialization-xmlserializer-live',
	'serialization-xmlserializer-parsed-and-svg',
	'storage-clear',
	'storage-delete-property',
	'storage-event-child-frame',
	'storage-event-parent-listens',
	'storage-key-by-index',
	'storage-missing-property-is-undefined',
	'stylesheets-constructable-url-readback',
	'stylesheets-document-stylesheets-href',
	'unsafeprops-delete',
	'unsafeprops-frozen-strict-assign',
	'unsafeprops-null-prototype',
	'unsafeprops-proxy-get-trap-key',
	'unsafeprops-proxy-set-trap-key',
	'unsafeprops-super',
	'workers-module-with-static-import',
	'workers-self-origin',
]);

const MODES = [
	['same-origin', PROXY],
	['isolated', HOST],
];

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** the proxied page's frame: a direct child of the host document */
const proxiedFrame = (page) =>
	page
		.frames()
		.find(
			(f) =>
				f.parentFrame() === page.mainFrame() &&
				/\/stomp\/[\w-]+\/html\//.test(f.url()),
		);

/**
 * Load adv-<group>.html in one mode, send the host's message, wait for the
 * page to finish, return its probes and the host's state afterwards. A page
 * that navigates away mid-run (an escape in itself) yields its last snapshot
 * with `navigated` set.
 */
async function measure(browser, base, group, limit = 60000, before = null) {
	const page = await openDemo(browser, base);
	// what the browser holds for the proxy origin before the page runs
	if (before) await before(page, browser, base);
	const recorder = await recordRequests(page.context());
	const host = await page.evaluate(() => {
		window.__hostMessages = [];
		// the host's document: a new one (the host page navigated, reloaded)
		// has no such property
		const nonce = String(Math.random()).slice(2);
		Object.defineProperty(window, '__advHostDocument', { value: nonce });
		// only the pages' own tagged payloads count: the controller's
		// $stomp$ control messages reach this listener too
		addEventListener('message', (event) => {
			const d = event.data;
			if (
				d &&
				typeof d === 'object' &&
				Object.keys(d).some(
					(k) => k.startsWith('$stomp$') || k === 'stomp-remote',
				)
			)
				return;
			let data;
			try {
				data = JSON.stringify(d);
			} catch (error) {
				data = String(d);
			}
			if (data.includes('__adv'))
				window.__hostMessages.push({
					origin: event.origin,
					data: data.slice(0, 200),
				});
		});
		return {
			title: document.title,
			url: location.href.split('#')[0],
			nonce,
		};
	});
	await submitLanding(page, `${FIXTURE}pages/adv-${group}.html`);
	let adv = {};
	let sentHostMessage = false;
	let lastSeen = 0;
	let navigated = false;
	const started = Date.now();
	while (Date.now() - started < limit) {
		await sleep(300);
		const frame = proxiedFrame(page);
		let current;
		try {
			current = (await frame?.evaluate(() => window.__adv)) || null;
		} catch (error) {
			// the frame is navigating; try again
			current = null;
		}
		if (current) {
			adv = current;
			lastSeen = Date.now();
			if (!sentHostMessage) {
				sentHostMessage = true;
				// the host posts once, like an embedding page would
				await page.evaluate(() => {
					const element = document.querySelector('.frame:not(.hidden)');
					element?.contentWindow?.postMessage(
						{ __advHost: 'host-message' },
						'*',
					);
				});
			}
			if (adv.done) break;
		} else if (lastSeen && Date.now() - lastSeen > 6000) {
			navigated = true;
			break;
		}
	}
	// give late messages at the host a moment
	await sleep(500);
	const after = await page.evaluate(() => {
		// the tokens the demo gave out (pm/main.js session): the address may
		// name the entry on show by one of them
		let tokens = {};
		try {
			tokens =
				JSON.parse(sessionStorage.getItem('stomp-demo:session'))?.tokens ?? {};
		} catch {
			// no session kept: no token is the demo's
		}
		const token =
			location.search
				.slice(1)
				.split('&')
				.filter((part) => /^\d+=?$/.test(part))
				.pop()
				?.replace('=', '') ?? '';
		return {
			title: document.title,
			url: location.href.split('#')[0],
			nonce: window.__advHostDocument ?? null,
			token,
			tokenKnown: !token || Object.hasOwn(tokens, token),
			// (none in another document: the listener went with the first)
			messages: window.__hostMessages ?? null,
			leak: window.__advLeak ?? null,
			docLeak: document.__advLeak ?? null,
		};
	});
	const frameUrl = proxiedFrame(page)?.url() ?? null;
	const errors = page.errors.filter((e) => !/max cycles/.test(e));
	await page.close();
	const raw = recorder.raw();
	return { host, after, adv, navigated, frameUrl, errors, raw };
}

/**
 * Run one group in both modes. `scramjet` maps a probe name to the scramjet
 * test it mirrors, for the "also fails" annotation. `limit`: how long the
 * page may run; `bypass: 'fail'` makes a request past the proxy a failure of
 * its own instead of a line outside the counts.
 *
 * `knownOpen`: the group's checks that fail today on purpose, keyed by what
 * follows `<mode>: <group>` in the check's name (a probe's name, or `page ran
 * to completion`, `host page untouched`, `makes no request past the proxy`).
 * The value is the reason, or `{ why, modes, chrome }` for an entry that
 * holds only in some modes (`['same-origin']`, `['isolated']`) or Chrome
 * majors (`[157]`, or a function of the major).
 *
 * `compare(probes, check)`: the group's checks across its probes (each
 * `check(key, condition, detail)`, in each mode, known open as above).
 *
 * `args` and `env`: the Chrome's (lib.mjs launch); `before(page, browser,
 * base)`: run on the host's page before the group's page loads (what the
 * browser holds for the proxy origin, say).
 */
export async function runGroup(
	group,
	scramjet = {},
	{
		limit = 60000,
		bypass = 'report',
		knownOpen = {},
		compare,
		args = [],
		env = null,
		before = null,
	} = {},
) {
	const browser = await launch(args, { env });
	const major = Number(browser.version().split('.')[0]);
	console.log(`Chrome ${browser.version()}`);
	const entries = Object.fromEntries(
		Object.entries(knownOpen).map(([key, entry]) => [
			key,
			typeof entry === 'string' ? { why: entry } : entry,
		]),
	);
	const applies = (entry, mode) =>
		(!entry.modes || entry.modes.includes(mode)) &&
		(!entry.chrome ||
			(typeof entry.chrome === 'function'
				? entry.chrome(major)
				: entry.chrome.includes(major)));
	const checked = new Set();
	// a check of this group (`probe` for a probe's, which reads <group>/<key>):
	// a listed one must still fail
	const check = (mode, key, probe, condition, detail) => {
		checked.add(key);
		const name = `${mode}: ${group}${probe ? '/' : ' '}${key}`;
		const entry = entries[key];
		if (!entry || !applies(entry, mode)) return ok(name, condition, detail);
		return ok(
			`${name} (known open: ${entry.why})`,
			!condition,
			condition
				? `passes now: the known-open entry is stale and goes - ${detail}`
				: detail,
		);
	};
	const errors = [];
	for (const [mode, base] of MODES) {
		const {
			host,
			after,
			adv,
			navigated,
			errors: pageErrors,
			raw,
		} = await measure(browser, base, group, limit, before);
		errors.push(...pageErrors.map((e) => `${mode}: ${e}`));
		const leak = new RegExp(
			[
				'/stomp/',
				'OTHER-WINDOW',
				'OTHER-DOCUMENT',
				'OTHER-ELEMENT',
				'TELL:',
				'LEAK:',
				'\\$s\\$',
				'createClient',
				// the proxy's own IndexedDB / cache names (stompConfig, stompCookies)
				'\\bstomp[A-Z]',
				`http://(127\\.0\\.0\\.1|localhost):${PORT}(?=[/"'\\s]|$)`,
				escapeRegExp(host.title),
			].join('|'),
		);
		const probes = Object.entries(adv.probes || {});
		check(
			mode,
			'page ran to completion',
			false,
			adv.done === true && !navigated,
			navigated
				? 'the page navigated away mid-run'
				: `${probes.length} probes recorded, done=${adv.done}`,
		);
		for (const [name, result] of probes) {
			const text = JSON.stringify(result.value ?? null);
			const leaked = result.value !== undefined && leak.test(text);
			const twin = scramjet[name];
			const note = twin
				? ` (scramjet ${twin}${SCRAMJET_FAILS.has(twin) ? ', also fails' : ''})`
				: '';
			const seen = result.error
				? `threw ${result.error}${result.message ? `: ${result.message}` : ''}`
				: `saw ${text.length > 500 ? `${text.slice(0, 500)}...` : text}`;
			check(mode, name, true, !leaked, `${seen}${note}`);
		}
		compare?.(adv.probes || {}, (key, condition, detail) =>
			check(mode, key, false, condition, detail),
		);
		check(
			mode,
			'host page untouched',
			false,
			// the same document at the same address, but for the token of the
			// entry on show the demo itself wrote (`?1`, pm/main.js
			// writeAddress), which a tab's navigation changes in place
			after.nonce === host.nonce &&
				hostPage(after.url) === hostPage(host.url) &&
				after.tokenKnown &&
				after.title === host.title &&
				after.leak === null &&
				after.docLeak === null &&
				after.messages?.length === 0,
			`url ${after.url}${after.nonce === host.nonce ? '' : ' (another document)'}${after.tokenKnown ? '' : ` (token ${after.token} the demo never gave out)`} title ${JSON.stringify(after.title)} marker ${JSON.stringify(after.leak)}/${JSON.stringify(after.docLeak)} messages ${String(JSON.stringify(after.messages)).slice(0, 300)}`,
		);
		// a request that reached the network without the proxy: its own line
		// kind, outside the probe counts
		for (const entry of raw)
			console.log(
				`BYPASS: ${mode}: ${group} ${entry.url.slice(0, 160)} (${entry.type}, ${entry.source})`,
			);
		if (bypass === 'fail')
			check(
				mode,
				'makes no request past the proxy',
				false,
				raw.length === 0,
				raw
					.map((entry) => `${entry.url.slice(0, 160)} (${entry.type})`)
					.slice(0, 40)
					.join(' | '),
			);
	}
	// an entry for this Chrome that names no check of the group (renamed,
	// removed) is stale
	const strays = Object.keys(entries).filter(
		(key) =>
			!checked.has(key) && MODES.some(([mode]) => applies(entries[key], mode)),
	);
	ok(
		`${group}: every known-open entry names a check`,
		strays.length === 0,
		JSON.stringify(strays),
	);
	await done(browser, errors);
}

if (process.argv[1]?.endsWith('adversarial-corpus.mjs')) {
	console.error(
		'adversarial-corpus.mjs is the shared runner; run an adversarial-<group> suite',
	);
}
