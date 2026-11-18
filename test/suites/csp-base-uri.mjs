// A page's base-uri must not spuriously refuse the page's own <base href>
// through the proxy. Natively a same-origin <base> under `base-uri 'self'` is
// accepted (the accounts.google.com sign-in page is this shape). The proxy
// serves the document from its own origin, and the inject keeps the base's
// real URL for a moment while it routes the base to the proxy origin
// (src/inject/dom/modules/DOMAttributes.ts); forwarding the page's base-uri
// unchanged makes the browser refuse that real-origin write, which Chrome
// logs to the console and ignores. src/csp.ts browserPolicy gives the browser
// the document's own origin as a base-uri source wherever the page's base-uri
// allows it, so the browser accepts the page's own base as natively, while a
// refused base's refusal URL (on refused.invalid) is still refused.
//
// The inject hides the spurious violation from the page's own listeners
// (src/inject/dom/modules/ContentSecurity.ts), so it is console-only: the
// csp-navigation oracle, which compares the probe outcomes and the
// securitypolicyviolation events the page sees, does not catch it. This suite
// compares the browser's console CSP messages as well. The page is a
// /csp/doc?s=nav page (test/csp-server.mjs, test/pages/csp-navigation-probes.js),
// its markup carrying a <base href> for each `b`; the base-parsed probe reads
// the base URL and a relative link, so a base the browser ignores shows up.
//
// A base each kind of base-uri refuses (report-only and enforced, by header
// and by meta, where a report-only meta is ignored natively) is compared
// with every field of its violations Chrome sets, where it says the code
// that set or inserted the base is (the page's script and position, or the
// markup's) and whether the event is its own and the one object every
// listener is handed among them, and how many the page sees.
import { report } from '../csp-lib.mjs';
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

/** the fixture's other origin (the same server under another host name) */
const OTHER = FIXTURE.includes('127.0.0.1')
	? FIXTURE.replace('127.0.0.1', 'localhost')
	: FIXTURE.replace('localhost', '127.0.0.1');

/** a /csp/doc navigation page whose markup carries a <base href> for each `b` */
function navURL(
	name,
	{
		p = [],
		ro = [],
		m = [],
		mro = [],
		b = [],
		probes = ['base-parsed'],
		source,
	},
) {
	const query = new URLSearchParams();
	for (const policy of [].concat(p)) query.append('p', policy);
	for (const policy of [].concat(ro)) query.append('ro', policy);
	for (const policy of [].concat(m)) query.append('m', policy);
	for (const policy of [].concat(mro)) query.append('mro', policy);
	// (the probes record where the browser says the code was, and isTrusted)
	if (source) query.set('source', '1');
	// the navigation page (its probe script, the metas, then a <base> per `b`);
	// built here directly, not through csp-lib's caseURL
	query.set('s', 'nav');
	for (const href of [].concat(b)) query.append('b', href);
	query.set('probes', probes.join(','));
	query.set('case', name);
	return `${FIXTURE}csp/doc?${query}`;
}

const CASES = {
	// the Google sign-in shape: a same-origin <base> under base-uri 'self'.
	// Native accepts it with no console violation; the proxy must too.
	'a same-origin base under base-uri self': {
		p: "base-uri 'self'",
		b: `${FIXTURE}signin/`,
		// natively the page's own base is accepted: no base-uri console message
		baseConsole: true,
	},
	// a cross-origin base base-uri 'self' refuses: native reports it, and the
	// proxy still does (its refusal URL), so the page sees the violation either
	// way. A no-regression guard for refused bases.
	'a cross-origin base base-uri self refuses': {
		p: "base-uri 'self'",
		b: `${OTHER}x/`,
	},
	// Under a report-only base-uri 'none' the page saw two violations of one
	// base: the inject's report (src/inject/dom/rareAttributes.ts reportBase)
	// and the browser's, of its own report-only copy of 'none', which refuses
	// the base's route too (src/csp.ts browserPolicy)
	"a report-only base-uri 'none' by header, a parsed base": {
		ro: "base-uri 'none'",
		b: `${FIXTURE}x/`,
		source: true,
	},
	"a report-only base-uri 'none' by header, bases a script inserts": {
		ro: "base-uri 'none'",
		probes: ['base-self', 'base-other', 'base-change'],
		source: true,
	},
	'a report-only base-uri self by header, a cross-origin base': {
		ro: "base-uri 'self'",
		b: `${OTHER}x/`,
		probes: ['base-parsed', 'base-other'],
		source: true,
	},
	'a report-only base-uri self by header, bases a script inserts': {
		ro: "base-uri 'self'",
		probes: ['base-self', 'base-other', 'base-change'],
		source: true,
	},
	'an enforced base-uri self by header, bases a script inserts': {
		p: "base-uri 'self'",
		probes: ['base-other', 'base-change'],
		source: true,
	},
	"a report-only base-uri 'none' by meta, ignored": {
		mro: "base-uri 'none'",
		b: `${FIXTURE}x/`,
		probes: ['base-parsed', 'base-self'],
		source: true,
	},
	"an enforced base-uri 'none' by header": {
		p: "base-uri 'none'",
		b: `${FIXTURE}x/`,
		probes: ['base-parsed', 'base-self'],
		source: true,
	},
	"an enforced base-uri 'none' by meta": {
		m: "base-uri 'none'",
		b: `${FIXTURE}x/`,
		probes: ['base-parsed', 'base-self'],
		source: true,
	},
	"an enforced and a report-only base-uri 'none' by header": {
		p: "base-uri 'none'",
		ro: "base-uri 'none'",
		probes: ['base-self'],
		source: true,
	},
};

/** base-uri console violations ("Setting the document's base URI to ...") */
function trackBaseConsole(page) {
	const seen = [];
	page.on('console', (message) => {
		if (/Setting the document's base URI/i.test(message.text()))
			seen.push(message.text());
	});
	return seen;
}

/** a case's violations as compared: with `source`, every field the probes recorded */
const events = (value, source) =>
	(value?.events ?? [])
		.map((event) =>
			source
				? JSON.stringify(event)
				: [event.effectiveDirective, event.blockedURI, event.disposition].join(
						' ',
					),
		)
		.sort();

const browser = await launch();

const native = {};
for (const [name, spec] of Object.entries(CASES)) {
	const page = await browser.newPage();
	const baseLogs = trackBaseConsole(page);
	await page.goto(navURL(name, spec));
	const value = await report(page, name);
	// a trailing task for the browser's own base-uri console message, if any
	await sleep(300);
	native[name] = { value, console: baseLogs.length };
	await page.close();
}
ok(
	'natively, every case reports',
	Object.values(native).every(({ value }) => value?.done),
	JSON.stringify(
		Object.keys(native).filter((name) => !native[name].value?.done),
	),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	for (const [name, spec] of Object.entries(CASES)) {
		const baseLogs = trackBaseConsole(page);
		const before = baseLogs.length;
		await submitLanding(page, navURL(name, spec));
		const value = await report(page, name);
		await sleep(300);
		const proxiedConsole = baseLogs.length - before;
		const want = native[name].value;
		ok(
			`${mode}: ${name}: the base resolves as natively`,
			value && JSON.stringify(value.results) === JSON.stringify(want?.results),
			JSON.stringify({ native: want?.results, proxied: value?.results }).slice(
				0,
				500,
			),
		);
		const wanted = events(want, spec.source);
		const got = events(value, spec.source);
		ok(
			`${mode}: ${name}: the violations the page sees are the native ones`,
			wanted.length === got.length &&
				wanted.every((event, index) => event === got[index]),
			JSON.stringify({ native: wanted, proxied: got }),
		);
		// where the page's base-uri accepts its own base, the proxy must not
		// make the browser log a base-uri violation the native page never sees
		if (spec.baseConsole)
			ok(
				`${mode}: ${name}: no spurious base-uri console violation`,
				native[name].console === 0 && proxiedConsole === 0,
				JSON.stringify({
					native: native[name].console,
					proxied: proxiedConsole,
				}),
			);
	}
	await page.close();
}

await done(browser);
