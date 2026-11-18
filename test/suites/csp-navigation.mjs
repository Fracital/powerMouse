// A page's own Content-Security-Policy governs where its documents go as
// natively (test/csp-server.mjs, test/pages/csp-navigation-probes.js):
// base-uri (a refused <base> leaves the document's URL as the base URL),
// form-action (a refused submission sends nothing, on every redirect hop,
// into a frame or a new window, a javascript: action even under `*`),
// frame-ancestors (a framed document whose policy refuses one of its real
// ancestors shows an error page, with no event anywhere), and a frame's
// navigations other than the src its parent sets (a redirect hop, a
// navigation the frame starts), which are the parent's frame-src's to
// judge. navigate-to does nothing, as in Chrome. The violation is the
// browser's own wherever native Chrome fires one, and names the page's
// URLs and policy. Compared with the pages loaded natively, in both modes.
import { caseURL, compareCases, FIELDS, OTHER, report } from '../csp-lib.mjs';
import { done, launch } from '../lib.mjs';

const other = OTHER.replace(/\/$/, '');

const CASES = {
	'a parsed base the policy refuses': {
		s: 'nav',
		p: "base-uri 'self'",
		b: `${other}/x/`,
		probes: ['base-parsed'],
	},
	'a parsed base the policy allows': {
		s: 'nav',
		p: `base-uri ${other}`,
		b: `${other}/x/`,
		probes: ['base-parsed'],
	},
	'two parsed bases, the first refused': {
		s: 'nav',
		p: "base-uri 'self'",
		b: [`${other}/x/`, '/y/'],
		probes: ['base-parsed'],
	},
	'a meta base-uri': {
		s: 'nav',
		m: "base-uri 'self'",
		b: `${other}/x/`,
		probes: ['base-parsed'],
	},
	'bases a script inserts': {
		s: 'nav',
		p: "base-uri 'self'",
		probes: ['base-other', 'base-self', 'base-change', 'base-two'],
	},
	"base-uri 'none'": {
		s: 'nav',
		p: "base-uri 'none'",
		probes: ['base-self'],
	},
	'a report-only base-uri': {
		s: 'nav',
		ro: "base-uri 'self'",
		b: `${other}/x/`,
		probes: ['base-parsed', 'base-other'],
	},
	'default-src does not govern bases': {
		s: 'nav',
		p: "default-src 'self'; script-src 'self' 'unsafe-inline'",
		probes: ['base-other'],
	},
	'forms the page submits': {
		s: 'nav',
		p: "form-action 'self'",
		probes: [
			'sub:form-get-other',
			'sub:form-get-other-click',
			'sub:form-get-self',
			'sub:form-post-other',
		],
	},
	'forms whose submission redirects': {
		s: 'nav',
		p: "form-action 'self'",
		probes: [
			'sub:form-redirect-other',
			'sub:form-post-redirect-other',
			'sub:form-redirect-self',
		],
	},
	'forms aimed elsewhere': {
		s: 'nav',
		p: "form-action 'self'",
		probes: [
			'form-blank-other',
			'form-blank-self',
			'form-frame-other',
			'form-frame-redirect-other',
		],
	},
	'a submission while the document is parsed': {
		s: 'nav',
		p: "form-action 'self'",
		probes: ['form-during-parse'],
	},
	'javascript: actions': {
		s: 'nav',
		p: 'form-action *',
		probes: ['sub:form-javascript', 'sub:form-get-other'],
	},
	'a meta form-action': {
		s: 'nav',
		m: "form-action 'self'",
		probes: ['sub:form-get-other', 'form-frame-other'],
	},
	'a report-only form-action': {
		s: 'nav',
		ro: "form-action 'self'",
		probes: ['form-blank-other', 'form-frame-other'],
	},
	// (one form, one violation: the browser's copy of one that allows
	// nothing refused the form's route three times over, so it gets the
	// route's 'self', src/csp.ts browserPolicy, and the inject reports it)
	"a report-only form-action 'none'": {
		s: 'nav',
		ro: "form-action 'none'",
		probes: [
			'form-blank-other',
			'form-frame-other',
			'form-blank-self',
			'form-frame-redirect-other',
		],
	},
	'default-src does not govern forms': {
		s: 'nav',
		p: "default-src 'self'; script-src 'self' 'unsafe-inline'",
		probes: ['form-blank-other'],
	},
	"a framed document's frame-ancestors": {
		s: 'nav',
		probes: [
			'fa-other-self',
			'fa-self-self',
			'fa-self-none',
			'fa-other-host',
			'fa-self-other-only',
		],
	},
	'frame-ancestors by wildcard, meta, report-only, two policies': {
		s: 'nav',
		probes: [
			'fa-other-star',
			'fa-self-meta-none',
			'fa-self-ro-none',
			'fa-self-two',
		],
	},
	'frame-ancestors judges every ancestor': {
		s: 'nav',
		probes: ['sub-other:fa-other-self', 'sub-plain:fa-self-self'],
	},
	"a frame's redirects": {
		s: 'nav',
		p: "frame-src 'self'",
		probes: ['frame-redirect-other', 'frame-redirect-self'],
	},
	'navigations a frame starts': {
		s: 'nav',
		p: "frame-src 'self'",
		probes: [
			'frame-nav-other',
			'frame-nav-other-heard',
			'frame-replace-other-heard',
			'frame-nav-self',
			'frame-link-other',
			'frame-form-other',
			'frame-nav-redirect-other',
		],
	},
	'a refused form, as its frame hears of it': {
		s: 'nav',
		p: "frame-src 'self'",
		probes: ['frame-form-other-heard'],
	},
	'a frame of the other origin': {
		s: 'nav',
		p: `frame-src ${other}`,
		probes: ['frame-other-redirect-self', 'frame-other-nav-self'],
	},
	'a report-only frame-src': {
		s: 'nav',
		ro: "frame-src 'self'",
		probes: ['frame-redirect-other', 'frame-nav-other'],
	},
	'navigate-to does nothing': {
		s: 'nav',
		p: "navigate-to 'none'",
		probes: ['frame-nav-other', 'sub:form-get-other'],
	},
};

// What differs from native and stays so (docs/csp.md, "Not yet as
// natively"): case, probe, why. A probe listed here must differ in both
// modes; one that matches again fails the suite.
const EXPECTED = {
	'a refused form, as its frame hears of it': {
		'frame-form-other-heard':
			"the navigation the parent's frame-src refuses is made again to a refusal URL, for the browser to refuse, and that one is no form submission: the navigate event the frame hears has no formData",
	},
};

// Where a form's violation says the code that submitted it was: the page's
// call of submit() or requestSubmit() for a form into a frame, none for a
// new window's (natively its navigation is judged later). The browser's
// names the inject's hook and the inject's names nothing, but for the place
// the hook noted (src/inject/dom/violations.ts noteFormSite)
const FORMS = [
	'form-blank-other',
	'form-frame-other',
	'form-frame-redirect-other',
];
const PLACED = {
	'a report-only form-action, where the forms were submitted': {
		s: 'nav',
		ro: "form-action 'self'",
		source: true,
		probes: FORMS,
	},
	"a report-only form-action 'none', where the forms were submitted": {
		s: 'nav',
		ro: "form-action 'none'",
		source: true,
		probes: [...FORMS, 'form-blank-self'],
	},
	'an enforced form-action, where the forms were submitted': {
		s: 'nav',
		p: "form-action 'self'",
		source: true,
		probes: FORMS,
	},
};

const browser = await launch();
if (process.env.CSP_NATIVE_DUMP) {
	// the native reports only, for measuring
	for (const [name, spec] of Object.entries(CASES)) {
		const page = await browser.newPage();
		await page.goto(caseURL(name, spec));
		console.log(JSON.stringify({ name, report: await report(page, name) }));
		await page.close();
	}
} else {
	await compareCases(browser, CASES, { expected: EXPECTED });
	await compareCases(browser, PLACED, {
		fields: [
			...FIELDS,
			'sourceFile',
			'lineNumber',
			'columnNumber',
			'isTrusted',
			'windowEvent',
			'methods',
			'alike',
		],
	});
}
await done(browser);
