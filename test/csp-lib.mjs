// What the csp-* suites share: a case is a page of test/csp-server.mjs
// under the policies it names, whose probes (test/pages/csp-probes.js) say
// what each load or piece of code did and which securitypolicyviolation
// events the document saw. `compareCases` loads every case natively, then
// through the proxy in both modes, and checks that the page sees the same.
import {
	FIXTURE,
	HOST,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from './lib.mjs';

/** the fixture's other origin (the same server under another host name) */
export const OTHER = FIXTURE.includes('127.0.0.1')
	? FIXTURE.replace('127.0.0.1', 'localhost')
	: FIXTURE.replace('localhost', '127.0.0.1');

/** the page of a case named `name` */
export function caseURL(
	name,
	{ p = [], ro = [], m = [], pp = [], b = [], h, s, js, fs, probes },
) {
	const query = new URLSearchParams();
	for (const policy of [].concat(p)) query.append('p', policy);
	for (const policy of [].concat(ro)) query.append('ro', policy);
	for (const policy of [].concat(m)) query.append('m', policy);
	// a Permissions-Policy header (e.g. sync-xhr=()): the kits4beats/Cloudflare
	// challenge shape sends one alongside its connect-src, and a proxied
	// data:/blob: fetch its connect-src refuses must still be refused by the
	// browser's connect-src, never turned into a "disabled by permissions
	// policy" sync-XHR error (src/inject/dom/Client.ts connectRefusal)
	for (const policy of [].concat(pp)) query.append('pp', policy);
	// `s`: 'nav' for the navigation probes' page (their script, and the
	// markup's <base> elements), true for the ordinary page with styles in
	// its markup
	if (s) query.set('s', s === true ? '1' : s);
	for (const href of [].concat(b)) query.append('b', href);
	if (h) query.set('h', h);
	if (js) query.set('js', js);
	// `fs`: the case in a frame with this sandbox attribute
	if (fs !== undefined) query.set('fs', fs);
	query.set('probes', probes.join(','));
	query.set('case', name);
	return `${FIXTURE}csp/doc?${query}`;
}

/** the report of the newest frame of `page` that ran `name`'s case */
export async function report(page, name) {
	for (let i = 0; i < 160; i++) {
		await sleep(250);
		for (const frame of page.frames().reverse()) {
			// (the probes read the case from the page's URL: an evaluate here
			// runs unrewritten, where location is the proxy's)
			const value = await frame
				.evaluate(
					(wanted) =>
						window.__csp?.done && window.__csp.case === wanted
							? window.__csp
							: null,
					name,
				)
				.catch(() => null);
			if (value) return value;
		}
	}
	return null;
}

/** a violation as compared: what the page reads of it, in a stable order */
export const shape = (events, fields) =>
	(events ?? [])
		.map((event) =>
			JSON.stringify(
				Object.fromEntries(fields.map((field) => [field, event[field]])),
			),
		)
		.sort();

/** what of `list` is not in `other`, as many times as it is more often in `list` */
function without(list, other) {
	const left = [...other];
	return list.filter((item) => {
		const index = left.indexOf(item);
		if (index === -1) return true;
		left.splice(index, 1);
		return false;
	});
}

/** a compared violation as a failure names it: what tells it apart */
function brief(text) {
	const event = JSON.parse(text);
	return [
		event.effectiveDirective,
		event.blockedURI,
		event.disposition,
		event.sample,
		event.target,
		event.originalPolicy?.slice(0, 60),
		event.documentURI?.slice(-40),
	].join(' | ');
}

/** the fields of a violation compared by default */
export const FIELDS = [
	'blockedURI',
	'violatedDirective',
	'effectiveDirective',
	'originalPolicy',
	'disposition',
	'documentURI',
	'statusCode',
	'sample',
	'target',
];

/**
 * Every case of `cases` natively, then in both modes: each probe's outcome
 * and the violations (their `fields`) as natively. Returns the native
 * reports.
 *
 * `expected`: the differences from native that are known and kept (each
 * one listed in docs/csp.md), as `{ case: { probe: why } }`; the key
 * `violations` lists the case's violations as one. A listed probe
 * must differ from native in both modes: the suite fails when one matches
 * again (the entry and the doc's line then go), as it does for a
 * difference that is not listed.
 */
export async function compareCases(
	browser,
	cases,
	{ fields = FIELDS, expected = {} } = {},
) {
	const strays = Object.entries(expected).flatMap(([name, probes]) =>
		Object.keys(probes)
			.filter(
				(probe) =>
					probe !== 'violations' && !cases[name]?.probes.includes(probe),
			)
			.map((probe) => `${name}: ${probe}`),
	);
	if (Object.keys(expected).length)
		ok(
			'every listed difference names a probe of a case',
			strays.length === 0,
			JSON.stringify(strays),
		);
	const native = {};
	for (const [name, spec] of Object.entries(cases)) {
		const page = await browser.newPage();
		await page.goto(caseURL(name, spec));
		native[name] = await report(page, name);
		await page.close();
	}
	ok(
		'natively, every case reports',
		Object.values(native).every((value) => value?.done),
		JSON.stringify(Object.keys(native).filter((name) => !native[name]?.done)),
	);
	// A case that exercises nothing passes any comparison: natively and
	// proxied, a page that does not know a probe answers "no such probe" for
	// it, and the two match. So every probe a case names must have run
	// natively and said something (a `sub:` probe's answer is its frame's
	// report, which names its own probe's answer).
	const vacuous = Object.entries(cases).flatMap(([name, spec]) => {
		const results = native[name]?.results ?? {};
		const idle = spec.probes.filter(
			(probe) =>
				results[probe] === undefined ||
				results[probe] === null ||
				results[probe] === '' ||
				String(results[probe]).includes('no such probe'),
		);
		if (!spec.probes.length) return [`${name}: no probes`];
		return idle.map((probe) => `${name}: ${probe}: ${results[probe]}`);
	});
	ok(
		'natively, every probe a case names runs',
		vacuous.length === 0,
		JSON.stringify(vacuous).slice(0, 3000),
	);
	for (const [mode, base] of [
		['same-origin', PROXY],
		['isolated', HOST],
	]) {
		const page = await openDemo(browser, base);
		for (const [name, spec] of Object.entries(cases)) {
			await submitLanding(page, caseURL(name, spec));
			const proxied = await report(page, name);
			const want = native[name];
			const { violations: knownViolations, ...known } = expected[name] ?? {};
			const differs = Object.keys(want?.results ?? {}).filter(
				(probe) => want.results[probe] !== proxied?.results?.[probe],
			);
			const differing = differs.filter((probe) => !(probe in known));
			ok(
				`${mode}: ${name}: every probe does what it does natively`,
				proxied && differing.length === 0,
				JSON.stringify(
					Object.fromEntries(
						differing.map((probe) => [
							probe,
							[want.results[probe], proxied?.results?.[probe]],
						]),
					),
				).slice(0, 1500),
			);
			if (Object.keys(known).length) {
				const matching = Object.keys(known).filter(
					(probe) => !differs.includes(probe),
				);
				ok(
					`${mode}: ${name}: every listed difference is still one`,
					proxied && matching.length === 0,
					JSON.stringify(
						matching.length
							? { 'as natively now': matching }
							: Object.fromEntries(
									Object.keys(known).map((probe) => [
										probe,
										[want?.results[probe], proxied?.results?.[probe]],
									]),
								),
					).slice(0, 1500),
				);
			}
			const wanted = shape(want?.events, fields);
			const got = shape(proxied?.events, fields);
			const same =
				wanted.length === got.length &&
				wanted.every((event, index) => event === got[index]);
			// a case whose violations are a listed difference (`violations`)
			if (knownViolations)
				ok(
					`${mode}: ${name}: the violations are still the listed difference`,
					proxied && !same,
					knownViolations,
				);
			else
				ok(
					`${mode}: ${name}: the violations the page sees are the native ones`,
					proxied && same,
					JSON.stringify({
						missing: without(wanted, got).map(brief),
						extra: without(got, wanted).map(brief),
					}).slice(0, 3000),
				);
		}
		await page.close();
	}
	return native;
}
