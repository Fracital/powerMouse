// Speculation rules (an inline <script type="speculationrules">, one a
// script inserts, and the Speculation-Rules response header): natively the
// browser prefetches and prerenders the URLs they list from the page's
// top-level document. Through the proxy the browser would fetch an absolute
// URL of the rules by itself, past the worker (the user's own address
// reaching the site, with none of the proxy's cookies or headers), and a
// relative one against the proxy origin. Measured here in both a proxied
// top (a frame of the host, where Chrome never acts on speculation rules)
// and a proxied popup (a top-level window): no request of the rules reaches
// the fixture except through the proxy. Same-origin mode.
import {
	done,
	FIXTURE,
	launch,
	ok,
	PROXY,
	recordRequests,
	RUN,
	sleep,
} from '../lib.mjs';

const json = (key) =>
	JSON.stringify({
		prefetch: [
			{
				source: 'list',
				urls: [
					`${FIXTURE}hdr/doc?k=${key}&r=prefetch-abs`,
					`/hdr/doc?k=${key}&r=prefetch-rel`,
				],
			},
		],
		prerender: [
			{ source: 'list', urls: [`${FIXTURE}hdr/doc?k=${key}&r=prerender-abs`] },
		],
	});
/** a page with the rules of `key` inline, inserted and in its header */
const page = (key) => {
	const header = `${FIXTURE}hdr/doc?k=${key}-rules&h=${encodeURIComponent('access-control-allow-origin:*')}&ct=${encodeURIComponent('application/speculationrules+json')}&body=${encodeURIComponent(json(`${key}-header`))}`;
	const body = `<!doctype html><title>speculation</title>
<script type="speculationrules">${json(`${key}-inline`)}</script>
<script>
	const rules = document.createElement('script');
	rules.type = 'speculationrules';
	rules.textContent = ${JSON.stringify(json(`${key}-inserted`))};
	document.head.append(rules);
	// an empty one connected first, given its text by a setter, by a child
	const set = document.createElement('script');
	set.type = 'speculationrules';
	document.head.append(set);
	set.text = ${JSON.stringify(json(`${key}-set`))};
	const child = document.createElement('script');
	child.type = 'speculationrules';
	document.head.append(child);
	child.append(document.createTextNode(${JSON.stringify(json(`${key}-child`))}));
	document.write('<script type="speculationrules">' + ${JSON.stringify(json(`${key}-written`))} + '<\\/script>');
	// what the page reads back of its rules
	window.__texts = [...document.querySelectorAll('script[type=speculationrules]')].map(
		(script) => script.text === script.textContent && JSON.parse(script.text),
	);
	window.__ready = true;
</script>`;
	return `${FIXTURE}hdr/doc?h=${encodeURIComponent(`speculation-rules:"${header}"`)}&body=${encodeURIComponent(body)}`;
};
const log = async (key) =>
	(await (await fetch(`${FIXTURE}hdr/log?k=${key}`)).json()).map(
		(entry) => `${new URLSearchParams(entry.query).get('r')}:${entry.purpose}`,
	);
const forms = ['inline', 'inserted', 'set', 'child', 'written', 'header'];
const logs = async (key) =>
	Object.fromEntries(
		await Promise.all(
			forms.map(async (form) => [form, await log(`${key}-${form}`)]),
		),
	);

// the documents' keys, this run's own (lib.mjs RUN)
const [NATIVE, FRAMED, POPUP] = ['native', 'framed', 'popup'].map(
	(key) => `${key}${RUN}`,
);

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(page(NATIVE));
await sleep(4000);
const normal = (texts) =>
	JSON.stringify(texts).replace(/(native|framed|popup)\w*-/g, 'K-');
const nativeTexts = normal(await nativePage.evaluate(() => window.__texts));
const native = await logs(NATIVE);
await nativePage.close();
console.log('native', JSON.stringify(native));
ok(
	'natively, a top-level document prefetches and prerenders what each form of its rules lists',
	forms.every((form) => native[form].length > 0),
	JSON.stringify(native),
);

const host = await browser.newPage();
const errors = [];
host.on('pageerror', (error) => errors.push(error.message));
const recorder = await recordRequests(host.context());
await host.goto(PROXY);
await host.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
// a controller with no onOpen: the popup is a real top-level window
await host.evaluate(async (url) => {
	const element = document.createElement('iframe');
	element.style.cssText = 'width: 800px; height: 600px';
	document.body.append(element);
	const controller = new window.StompController({
		serviceworker: window.controller.serviceworker,
		transport: window.controller.transport,
		directory: window.controller.directory.pathname,
		codec: 'xor',
	});
	await controller.wait();
	await controller.createFrame(element).go(url);
}, page(FRAMED));
await sleep(4000);
const popup = host.context().waitForEvent('page');
for (const frame of host.frames())
	await frame
		.evaluate((url) => window.__ready && window.open(url), page(POPUP))
		.catch(() => null);
const opened = await popup;
await opened.waitForLoadState().catch(() => null);
await sleep(5000);
const texts = [];
for (const each of [host, opened])
	for (const frame of each.frames())
		texts.push(
			await frame.evaluate(() => window.__texts ?? null).catch(() => null),
		);
const proxiedTexts = texts.filter(Boolean).map(normal);
ok(
	'a proxied top and a proxied popup read back their own rules, as natively',
	proxiedTexts.length === 2 &&
		proxiedTexts.every((text) => text === nativeTexts),
	JSON.stringify({ nativeTexts, proxiedTexts }),
);
const framed = await logs(FRAMED);
const popped = await logs(POPUP);
console.log('framed', JSON.stringify(framed));
console.log('popup', JSON.stringify(popped));
const raw = recorder
	.raw()
	.filter((entry) => entry.url.includes('/hdr/'))
	.map((entry) => `${entry.url.slice(0, 120)} (${entry.type})`);
ok(
	'no prefetch or prerender of the rules reaches the site past the proxy',
	raw.length === 0,
	JSON.stringify(raw),
);
for (const [where, seen] of [
	['a proxied top', framed],
	['a proxied popup', popped],
])
	for (const form of forms)
		ok(
			`${where}: the ${form} rules fetch nothing directly`,
			seen[form].every((entry) => !/:prefetch/.test(entry)) || raw.length === 0,
			JSON.stringify(seen[form]),
		);
await done(browser, errors);
