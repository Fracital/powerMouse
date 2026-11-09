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

// an inline route with a token nobody registered: the error page
const page = await openDemo(browser, PROXY);
const unknown = await page.evaluate(async (fixture) => {
	// a navigation, which the worker answers (the host page itself is not
	// under its scope, so its own fetch would reach the demo server)
	const routed = await window.controller.route(`${fixture}pages/hist-1.html`);
	const element = document.createElement('iframe');
	element.src = routed.replace(/\/html\//, `/inline:${'A'.repeat(22)}/`);
	document.body.append(element);
	await new Promise((resolve) =>
		element.addEventListener('load', resolve, { once: true }),
	);
	const doc = element.contentDocument;
	return {
		title: doc?.title ?? null,
		text: (doc?.body?.textContent ?? '').slice(0, 160),
	};
}, FIXTURE);
ok(
	'an inline route with an unknown token answers the error page, not content',
	/unknown, used or expired|Page unavailable/.test(
		`${unknown.title} ${unknown.text}`,
	) && unknown.title !== 'HIST 1',
	JSON.stringify(unknown),
);
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
const route = await proxied.evaluate(() =>
	window['$P$s'].inlineDocument(
		'<title>ONCE</title><p>once</p>',
		location.href,
		location.href,
	),
);
const twice = await page.evaluate(async (route) => {
	const load = async () => {
		const element = document.createElement('iframe');
		element.src = route;
		document.body.append(element);
		await new Promise((resolve) =>
			element.addEventListener('load', resolve, { once: true }),
		);
		return element.contentDocument?.title ?? null;
	};
	return [await load(), await load()];
}, route);
ok(
	'an inline token is single-use: the document loads once, the same route again gets the error page',
	twice[0] === 'ONCE' && twice[1] === 'Page unavailable',
	JSON.stringify([route?.slice(-40), twice]),
);
await done(browser, errors);
