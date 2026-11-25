// deferred-refusals with a configured user agent (test/run.mjs SUITE_ENV, as
// the public demo always has one) and a fingerprinting surface on: the
// configured identity (src/inject/modules/NavigatorIdentity.ts) and the
// Fingerprint module are deferred parts a document applies as it starts
// (src/inject/dom/document.ts), so a frame that cannot have the parts
// would load nothing. It loads: its Navigator strings are the configured
// agent's, its userAgentData is gone (as Chrome gives none to an insecure
// context), nothing of the browser's own identity shows, its surfaces read
// as natively, and a call whose part is missing still refuses. With the
// parts, the same frame reads the configured identity and the capped core
// count, so neither answer is vacuous.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	waitActive,
} from '../lib.mjs';

const target = `${FIXTURE}pages/deferred-refusals.html`;
const host = new URL(FIXTURE).hostname;
// (test/run.mjs SUITE_ENV)
const FIXED =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.1234.56 Safari/537.36';
const CALLS = ['navigatorIdentity', 'getUserMedia', 'open'];

const browser = await launch();
const page = await openDemo(browser, PROXY);
// the host's page is the browser's own: its agent and core count
const native = await page.evaluate(() => ({
	userAgent: navigator.userAgent,
	cores: navigator.hardwareConcurrency,
}));
await page.evaluate(
	(host) =>
		window.controller.shields.set(host, {
			enabled: true,
			blockFingerprinting: true,
			fingerprint: { hardwareConcurrency: true },
		}),
	host,
);
await sleep(500);
await submitLanding(page, target);
const top = await waitActive(page, `typeof window.__child === 'function'`);
const name = await page.evaluate(() => window.controller.config.names.client);

const configured = (identity) =>
	identity?.userAgent === FIXED &&
	identity.appVersion === FIXED.slice(FIXED.indexOf('/') + 1) &&
	identity.platform === 'Linux x86_64';

{
	const answer = await top.evaluate(
		(calls) => window.__child(calls),
		['navigatorIdentity'],
	);
	const identity = answer.out?.navigatorIdentity;
	ok(
		'with the parts, a frame reads the configured identity and the capped core count',
		native.userAgent !== FIXED &&
			configured(identity) &&
			identity.userAgentData === true &&
			identity.brands?.includes('Google Chrome 150') &&
			identity.cores === Math.min(native.cores, 2),
		`${JSON.stringify(answer)}, natively ${JSON.stringify(native)}`,
	);
}

{
	const answer = await top.evaluate(
		async ({ name, calls }) => {
			const client = window[name];
			Reflect.defineProperty(client, 'deferredPartsText', {
				configurable: true,
				value: () => '__stompDeferred=function(){throw new Error("no parts")};',
			});
			try {
				return await window.__child(calls);
			} finally {
				Reflect.deleteProperty(client, 'deferredPartsText');
			}
		},
		{ name, calls: CALLS },
	);
	const identity = answer.out?.navigatorIdentity;
	ok(
		'without the parts, a frame under a configured user agent and a fingerprinting surface loads and answers',
		typeof answer.out === 'object' && answer.out !== null,
		JSON.stringify(answer),
	);
	ok(
		"without the parts, the frame's Navigator strings are the configured agent's",
		configured(identity),
		JSON.stringify(identity),
	);
	ok(
		'without the parts, the frame has no userAgentData, as a document Chrome gives none',
		identity?.userAgentData === false &&
			identity.brands === undefined &&
			identity.NavigatorUAData === 'undefined',
		JSON.stringify(identity),
	);
	ok(
		"without the parts, the frame's fingerprinting surface reads as natively",
		identity?.cores === native.cores,
		`${JSON.stringify(identity)}, natively ${native.cores}`,
	);
	ok(
		'without the parts, a call whose part is missing still refuses',
		answer.out?.getUserMedia?.promise === 'rejected: no parts' &&
			answer.out?.open?.threw === 'no parts',
		JSON.stringify(answer),
	);
}

await done(browser);
