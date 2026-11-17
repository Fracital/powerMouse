// WebAuthn's related origins request never leaves the browser past the proxy
// (src/inject/dom/modules/Credentials.ts). A relying party id that is not
// the document's host nor a suffix of it makes Chrome fetch
// https://<id>/.well-known/webauthn from its own process. A proxied page's
// requests reach the browser's own WebAuthn, whose document is the proxy's:
// on a proxy origin that is a domain, a page could make the browser reach
// any host directly, and a site's own id reaches the real site.
//
// The relying party ids here name a counter on 127.0.0.1 (Chrome maps the
// name there): any connection to it is the browser asking. Natively the
// page asks it, as Chrome does; through the demo on a domain
// (demo.localhost, the same-origin controller) it must not be asked, and
// every request must end as natively, with the words of a file that could
// not be fetched. The same-origin mode on an address (127.0.0.1) asks
// nothing either way (an address is no relying party), and the isolated
// mode's frame has no policy for create and get; its signal statics are
// the same hook as here. That is the demo without STomp's passkey provider
// (`?passkeys=off`); with it (docs/passkeys.md) the service worker answers
// for the proxied page's own origin, here an address, and must end every
// request as Chrome ends it for a page on an address, asking nobody.
import { createServer } from 'node:net';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const fixture = new URL(FIXTURE);
// the demo's server, under a name of its own: a domain, not an address
const DEMO = `http://demo.localhost:${new URL(HOST).port}/`;

// the counter: every connection is one the browser made for a relying party
let asked = 0;
const counter = createServer((socket) => {
	asked++;
	socket.destroy();
});
await new Promise((resolve) => counter.listen(0, '127.0.0.1', resolve));
const COUNTER = counter.address().port;
const RP = `wk${COUNTER}.co.uk`;
const args = [
	`--host-resolver-rules=MAP ${RP} 127.0.0.1:${COUNTER}, MAP *.${RP} 127.0.0.1:${COUNTER}, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1`,
];

// what a page asks: each relying party id in each call that names one
const CASES = {
	create: (rpId) =>
		navigator.credentials.create({
			publicKey: {
				rp: { id: rpId, name: 'x' },
				user: { id: new Uint8Array(4), name: 'a', displayName: 'a' },
				challenge: new Uint8Array(16),
				pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
				timeout: 3000,
			},
		}),
	get: (rpId) =>
		navigator.credentials.get({
			publicKey: { rpId, challenge: new Uint8Array(16), timeout: 3000 },
		}),
	signalUnknownCredential: (rpId) =>
		PublicKeyCredential.signalUnknownCredential({
			rpId,
			credentialId: 'AAAA',
		}),
	signalAllAcceptedCredentials: (rpId) =>
		PublicKeyCredential.signalAllAcceptedCredentials({
			rpId,
			userId: 'AAAA',
			allAcceptedCredentialIds: [],
		}),
	signalCurrentUserDetails: (rpId) =>
		PublicKeyCredential.signalCurrentUserDetails({
			rpId,
			userId: 'AAAA',
			name: 'a',
			displayName: 'a',
		}),
	// a malformed request is refused by its conversion first
	createNoChallenge: (rpId) =>
		navigator.credentials.create({
			publicKey: {
				rp: { id: rpId, name: 'x' },
				user: { id: new Uint8Array(4), name: 'a', displayName: 'a' },
				pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
			},
		}),
};
const IDS = {
	other: RP,
	// a name under it, a trailing dot, upper case: names too
	child: `www.${RP}`,
	dot: `${RP}.`,
	upper: RP.toUpperCase(),
	// a name with a port is no name: refused without a fetch
	port: `${RP}:443`,
	// read from a toString, once
	object: { toString: () => RP },
};

async function runAll(frame) {
	const out = {};
	for (const [name, call] of Object.entries(CASES))
		for (const [label, id] of Object.entries(IDS)) {
			if (name !== 'create' && label !== 'other' && label !== 'port') continue;
			const before = asked;
			const result = await frame
				.evaluate(
					async ([source, rpId, isObject]) => {
						const call = new Function(`return (${source})`)();
						const reads = { count: 0 };
						const value = isObject
							? {
									toString: () => {
										reads.count++;
										return rpId;
									},
								}
							: rpId;
						try {
							await call(value);
							return { resolved: true, reads: reads.count };
						} catch (error) {
							return {
								rejected: `${error.constructor.name}/${error.name}: ${error.message}`,
								reads: reads.count,
							};
						}
					},
					[
						call.toString(),
						typeof id === 'object' ? RP : id,
						typeof id === 'object',
					],
				)
				.catch((error) => ({ evaluate: String(error) }));
			// a fetch the browser started may connect a moment after the refusal
			await sleep(300);
			out[`${name} ${label}`] = { ...result, asked: asked - before };
		}
	return out;
}

// --- natively: a page on a domain (wk.localhost), which asks the counter,
// and the same page on an address (127.0.0.1), as the proxied page's origin is ---
const nativeBrowser = await launch(args);
const nativePage = await nativeBrowser.newPage();
await nativePage.goto(`http://wk.localhost:${fixture.port}/pages/fedcm.html`);
const native = await runAll(nativePage.mainFrame());
await nativePage.goto(`${FIXTURE}pages/fedcm.html`);
const nativeAddress = await runAll(nativePage.mainFrame());
await nativeBrowser.close();

// --- through the demo on a domain: the same-origin controller ---
const browser = await launch(args);
const errors = [];
/** the cases in a proxied page of the demo opened with `query` */
async function throughDemo(query) {
	const page = await openDemo(browser, `${DEMO}${query}`);
	await submitLanding(page, `${FIXTURE}pages/fedcm.html`);
	let frame = null;
	for (let i = 0; i < 160 && !frame; i++) {
		await sleep(250);
		const found = page
			.frames()
			.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
		if (
			await found
				?.evaluate(() => window.__fedcm?.ready === true)
				.catch(() => false)
		)
			frame = found;
	}
	ok(`the demo on a domain${query} opens the page`, !!frame);
	const out = frame ? await runAll(frame) : {};
	errors.push(...page.errors.map((error) => `demo: ${error}`));
	await page.close();
	return out;
}

const nativeAsked = Object.values(native).reduce((n, r) => n + r.asked, 0);
ok(
	'natively a page on a domain makes the browser ask a relying party id that is not its own (the oracle works)',
	native['create other'].asked > 0 &&
		native['signalUnknownCredential other'].asked > 0,
	JSON.stringify({ nativeAsked }),
);
const compare = (label, oracle, proxied) => {
	for (const [key, value] of Object.entries(oracle)) {
		const mine = proxied[key];
		ok(
			`${label}${key}: through the proxy the browser asks nobody, and the request ends as natively`,
			mine?.asked === 0 &&
				mine.rejected === value.rejected &&
				mine.resolved === value.resolved &&
				mine.reads === value.reads,
			JSON.stringify({ native: value, proxied: mine }),
		);
	}
};
// without STomp's passkey provider a proxied request reaches the browser's
// own WebAuthn behind the refusal, and ends as a page's on a domain does
compare('', native, await throughDemo('?passkeys=off'));
// with it STomp answers for the page's own origin (an address here, which
// is no relying party), and the browser is asked nothing either
compare(
	'with the provider, ',
	nativeAddress,
	await throughDemo('?passkeys=test'),
);

counter.close();
await done(browser, errors);
