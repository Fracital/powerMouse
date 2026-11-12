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
	{ p = [], ro = [], m = [], b = [], h, s, probes },
) {
	const query = new URLSearchParams();
	for (const policy of [].concat(p)) query.append('p', policy);
	for (const policy of [].concat(ro)) query.append('ro', policy);
	for (const policy of [].concat(m)) query.append('m', policy);
	// (the navigation probes: their script, and the markup's <base> elements)
	if (s) query.set('s', s);
	for (const href of [].concat(b)) query.append('b', href);
	if (h) query.set('h', h);
	if (s) query.set('s', '1');
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
 */
export async function compareCases(browser, cases, { fields = FIELDS } = {}) {
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
	for (const [mode, base] of [
		['same-origin', PROXY],
		['isolated', HOST],
	]) {
		const page = await openDemo(browser, base);
		for (const [name, spec] of Object.entries(cases)) {
			await submitLanding(page, caseURL(name, spec));
			const proxied = await report(page, name);
			const want = native[name];
			const differing = Object.keys(want?.results ?? {}).filter(
				(probe) => want.results[probe] !== proxied?.results?.[probe],
			);
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
			const wanted = shape(want?.events, fields);
			const got = shape(proxied?.events, fields);
			ok(
				`${mode}: ${name}: the violations the page sees are the native ones`,
				proxied &&
					wanted.length === got.length &&
					wanted.every((event, index) => event === got[index]),
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
