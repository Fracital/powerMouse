// Documents a page makes itself (a javascript: URL's string, a text/html
// blob, a data: frame) are served by the worker as inline documents, so
// they are controlled and everything they load goes through the worker: a
// stylesheet and its font, an inline style's url(), an image, a script and
// an XHR all show in the controller's request log, which only the worker
// writes. Their readbacks stay as they were: the data: frame is origin
// "null", the blob document shows the page's URL. An <object>'s document
// cannot be controlled (Chrome never hands an object's loads, or its
// document's own navigations, to a service worker): its script runs, its
// XHR goes through the page, and its markup subresources reach the worker
// as copies the page fetches (object-resources covers them against native).
// A route hit with an unknown token gets the error page. Both demo modes.
// With the site pool, an inline route is answered on the origin it names,
// whose worker alone holds its token, whatever site its referrer is of.
import {
	done,
	evaluateIsolated,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	SLOTS,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const errors = [];
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await page.evaluate(() => {
		window.__served = [];
		window.controller.addEventListener('request', (event) =>
			window.__served.push([event.detail.url, event.detail.status]),
		);
	});
	await submitLanding(page, `${FIXTURE}pages/inline-docs.html`);
	let inline = null;
	for (let i = 0; i < 50 && !inline?.done; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__inline)
				.catch(() => null);
			if (value) inline = value;
		}
	}
	// the request log reports a request after it finished, with a grace for
	// the frame it belongs to
	await sleep(3000);
	const served = await page.evaluate(() => window.__served);
	const through = (query) =>
		served.some(
			([url, status]) => url.includes(query) && status >= 200 && status < 400,
		);
	const loads = (tag) => ({
		stylesheet: through(`inline.css?${tag}`),
		style: through(`sprite.svg?${tag}-style`),
		image: through(`sprite.svg?${tag}-img`),
		script: through(`inline-script.js?${tag}`),
		xhr: through(`echo.json?${tag}-xhr`),
	});
	const reports = inline?.reports ?? {};
	for (const tag of ['javascript', 'blob', 'data']) {
		const report = reports[tag];
		const seen = loads(tag);
		ok(
			`${mode}: a ${tag} document is served by the worker and everything it loads goes through it`,
			report?.script === true &&
				report?.xhr === 200 &&
				Object.values(seen).every(Boolean),
			JSON.stringify({ report, seen }),
		);
	}
	ok(
		`${mode}: the stylesheet's font goes through the worker too`,
		through('font.woff2?inline-css-font'),
		JSON.stringify(served.filter(([url]) => url.includes('font.woff2'))),
	);
	ok(
		`${mode}: readbacks are unchanged: the data: frame is origin "null", the blob document shows the page's URL`,
		reports.data?.origin === 'null' &&
			reports.data?.messageOrigin === 'null' &&
			reports.data?.href?.startsWith('data:text/html,') &&
			reports.blob?.href === `${FIXTURE}pages/inline-docs.html` &&
			reports.javascript?.href === `${FIXTURE}pages/inline-docs.html`,
		JSON.stringify([
			reports.data,
			reports.blob?.href,
			reports.javascript?.href,
		]),
	);
	const object = loads('object');
	ok(
		`${mode}: an <object> document runs, its XHR goes through the page, and its markup subresources reach the worker`,
		reports.object?.script === true &&
			reports.object?.xhr === 200 &&
			Object.values(object ?? {}).every(Boolean),
		JSON.stringify({ report: reports.object, seen: object }),
	);
	errors.push(...page.errors.map((e) => `${mode}: ${e}`));
	await page.close();
}

const page = await openDemo(browser, PROXY);
// a token is single-use: the document it was registered for loads once,
// the same route again gets the error page
await page.evaluate(async (fixture) => {
	const element = document.createElement('iframe');
	document.body.append(element);
	window.__host = element;
	await window.controller
		.createFrame(element)
		.go(`${fixture}pages/hist-1.html`);
}, FIXTURE);
const proxied = page
	.frames()
	.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
const clientName = await page.evaluate(
	() => window.controller.config.names.client,
);
const route = await proxied.evaluate(
	(name) =>
		window[name].inlineDocument(
			'<title>ONCE</title><p>once</p>',
			location.href,
			location.href,
		),
	clientName,
);
// loaded by the host page, past every hook, on the origin of the document
// that registered it (with the site pool a slot's, whose worker holds the
// token), its title read in a world of its own in the frame
const twice = [];
for (const id of ['once-1', 'once-2']) {
	await page.evaluate(
		async ([route, id]) => {
			const element = document.createElement('iframe');
			element.id = id;
			element.src = route;
			document.body.append(element);
			await new Promise((resolve) =>
				element.addEventListener('load', resolve, { once: true }),
			);
		},
		[new URL(route, proxied.url()).href, id],
	);
	const frame = await (await page.$(`#${id}`))?.contentFrame();
	twice.push(
		frame
			? await evaluateIsolated(frame, () => document.title).catch(() => null)
			: null,
	);
}
ok(
	'an inline token is single-use: the document loads once, the same route again gets the error page',
	// (the demo's error page titles itself by the kind: routing)
	twice[0] === 'ONCE' && twice[1] === 'Something went wrong',
	JSON.stringify([route?.slice(-40), twice]),
);

// The site pool (docs/site-pool.md "Inline documents"): the worker of each
// origin of the proxy holds the tokens of that origin's documents only, and
// an inline route is answered by the worker of the origin it names, never
// sent on to another slot. Without a pool the host's origin is the only one.
const home = new URL(proxied.url()).origin;
const hub = new URL(PROXY).origin;
const origins = [...new Set([hub, ...SLOTS.map((o) => new URL(o).origin)])];
let shown = 0;
/** load `urls` at once in frames of the host page; what each shows, read past every hook */
async function show(urls) {
	const ids = urls.map(() => `shown-${shown++}`);
	await page.evaluate(
		(pairs) =>
			Promise.all(
				pairs.map(
					([url, id]) =>
						new Promise((resolve) => {
							const element = document.createElement('iframe');
							element.id = id;
							element.src = url;
							element.addEventListener('load', resolve, { once: true });
							document.body.append(element);
						}),
				),
			),
		urls.map((url, i) => [url, ids[i]]),
	);
	return Promise.all(
		ids.map(async (id) => {
			const frame = await (await page.$(`#${id}`))?.contentFrame();
			return frame
				? await evaluateIsolated(frame, () => ({
						origin: location.origin,
						title: document.title,
						text: (document.body?.textContent ?? '').slice(0, 160),
					})).catch(() => null)
				: null;
		}),
	);
}
const errorPage = (seen) =>
	/unknown, used or expired|Something went wrong/.test(
		`${seen?.title} ${seen?.text}`,
	);
const register = (markup, referrer) =>
	proxied.evaluate(
		([name, markup, referrer]) =>
			window[name].inlineDocument(
				markup,
				location.href,
				referrer ?? location.href,
			),
		[clientName, markup, referrer ?? null],
	);

// a token nobody registered, on every origin at once. A slot the pool has not
// brought up yet has no worker: the host's server answers its routes with
// its own 404, which is no content either
const unknownPath = new URL(proxied.url()).pathname.replace(
	/\/html\//,
	`/inline:${'A'.repeat(22)}/`,
);
const unknown = await show(origins.map((origin) => `${origin}${unknownPath}`));
ok(
	'an inline route with an unknown token answers the error page, not content, on the origin it names, on every origin of the proxy',
	unknown.every(
		(seen, i) =>
			seen?.origin === origins[i] &&
			!/HIST 1/.test(seen.title) &&
			(errorPage(seen) ||
				(origins[i] !== hub &&
					origins[i] !== home &&
					/^Cannot GET /.test(seen.text.trim()))),
	),
	JSON.stringify(
		unknown.map((seen, i) => [origins[i], seen?.origin, seen?.title]),
	),
);

// a document registered with the referrer of a site the pool shows from
// another slot (as a page shown from the host's origin when its slot is
// left out registers its own): the route names that referrer, but only the
// worker that took the registration has the document
const far = await register(
	'<title>FAR</title><p>far</p>',
	'https://elsewhere.example/page',
);
const [farSeen] = await show([new URL(far, proxied.url()).href]);
ok(
	'an inline document is served on the origin that registered it, whatever site its referrer is of',
	farSeen?.title === 'FAR' && farSeen.origin === home,
	JSON.stringify([home, farSeen]),
);

// another origin of the proxy has no way to the document: its worker never
// held the token, so it answers the route with the error page (and leaves
// the document to load once where it was registered)
if (origins.length > 1) {
	const held = new URL(
		await register('<title>HELD</title><p>held</p>'),
		proxied.url(),
	);
	// another slot whose worker is up (a spare) if there is one, else the
	// host's origin
	const away =
		origins.find(
			(origin, i) =>
				origin !== home &&
				origin !== hub &&
				!/^Cannot GET /.test(unknown[i]?.text.trim() ?? ''),
		) ?? hub;
	const [elsewhere] = await show([`${away}${held.pathname}`]);
	const [own] = await show([held.href]);
	ok(
		"an inline document is never served on another origin of the proxy than its own: the other's worker answers the error page, and the document still loads once on its own",
		elsewhere?.origin === away && errorPage(elsewhere) && own?.title === 'HELD',
		JSON.stringify([away, elsewhere, home, own]),
	);
}
await done(browser, errors);
