// A call whose code is a deferred part of the document bundle
// (src/inject/dom/deferredParts.ts) refuses when the parts cannot be had,
// and never reaches the browser's own API in their place: an identity
// credential's get and disconnect (FedCM). FedCM's part is made
// synchronously within the call that needs it, so no page code runs
// between the hook and the part. What is left to check is the part that
// throws instead.
//
// The tab's documents get, before any script of theirs (and so before the
// inject takes the browser's functions), counting stand-ins for the
// browser's functions behind those calls, which refuse instead of asking
// for a credential. The proxied top then hands a frame under it a parts
// statement that throws (as one of another build, deferred-parts, would
// hand none), and the frame makes the calls: each rejects, and no
// stand-in counted a call. The same frame with the parts gets FedCM's
// answers, so neither is vacuous.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	submitLanding,
	waitActive,
} from '../lib.mjs';

const target = `${FIXTURE}pages/deferred-refusals.html`;
const REFUSING = ['identity', 'disconnect'];
/** the calls that answer with a promise, which rejects */
const PROMISED = ['identity', 'disconnect'];

/** counting stand-ins for the browser's functions, in every document */
function countNatives() {
	const reached = (window.__nativeReached = []);
	const refuse = (name) =>
		function () {
			reached.push(name);
			return Promise.reject(new Error('the browser was asked'));
		};
	if (window.CredentialsContainer) {
		const identityGet = refuse('credentialsGet');
		// only an identity request is FedCM's: the passkeys part asks the
		// browser's get which members it reads, with an object that names
		// none, and reaches no authenticator
		CredentialsContainer.prototype.get = function (options) {
			if (options?.identity !== undefined) return identityGet();
			return Promise.reject(new Error('the browser was asked'));
		};
	}
	if (window.IdentityCredential)
		IdentityCredential.disconnect = refuse('disconnect');
}

const browser = await launch();
const page = await openDemo(browser, PROXY);
await page.addInitScript(countNatives);
await submitLanding(page, target);
const top = await waitActive(page, `typeof window.__child === 'function'`);
const name = await page.evaluate(() => window.controller.config.names.client);

// with the parts: FedCM answers
{
	const answer = await top.evaluate(
		(calls) => window.__child(calls),
		['identity', 'disconnect'],
	);
	// FedCM's protocol answers (the browser's get is never asked for an
	// identity, with the parts or without)
	const answered = (call) =>
		/^rejected: (?!no parts|pending)/.test(answer.out?.[call]?.promise ?? '');
	ok(
		"with the parts, FedCM's protocol answers an identity get and a disconnect",
		answered('identity') &&
			answered('disconnect') &&
			!answer.reached?.includes('credentialsGet') &&
			!answer.reached?.includes('disconnect'),
		JSON.stringify(answer.out),
	);
}

// without them: every call refuses, and nothing reaches the browser
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
		{ name, calls: REFUSING },
	);
	const out = answer.out ?? {};
	// the parts' own error; an identity get with STomp's passkey provider
	// in place goes to it, whose part is missing too: it ends as one the
	// user declined (Credentials DECLINED), never at the browser's get
	const refusedPromise = (call) =>
		/^rejected: no parts/.test(out[call]?.promise ?? '') ||
		(call === 'identity' &&
			/^rejected: The operation either timed out or was not allowed/.test(
				out[call]?.promise ?? '',
			));
	for (const call of PROMISED)
		ok(
			`without the parts, ${call} refuses with a rejected promise`,
			refusedPromise(call),
			JSON.stringify(out[call]),
		);
	ok(
		'without the parts, no call reaches the browser',
		Array.isArray(answer.reached) && answer.reached.length === 0,
		JSON.stringify(answer.reached),
	);
}

await done(browser);
