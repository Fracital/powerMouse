// Recognising what the markup means the way the parser does: a script type
// is a JavaScript MIME type whatever its case, spacing or legacy spelling (and
// nothing else runs); a link's rel is a token list, with `as` deciding the
// route of a preload; every SVG element that references a resource by href
// or xlink:href (gradients, patterns, filters, links, scripts) is routed.
// Same-origin mode, where the host realm reads the frame's real attributes.
import { done, FIXTURE, launch, ok, PROXY, sleep } from '../lib.mjs';

const browser = await launch();
const page = await browser.newPage();
await page.goto(PROXY);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
await page.evaluate(async (fixture) => {
	const element = document.createElement('iframe');
	document.body.append(element);
	window.__el = element;
	await window.controller.createFrame(element).go(`${fixture}pages/types.html`);
}, FIXTURE);
await sleep(2500);
const frame = page
	.frames()
	.find(
		(f) =>
			f.parentFrame() === page.mainFrame() &&
			/\/stomp\/[\w-]+\/html\//.test(f.url()),
	);

const scripts = await frame.evaluate(() => window.__t);
ok(
	'JavaScript MIME types in any case, spacing or legacy spelling run rewritten',
	scripts.spaced === true &&
		scripts.ecma === true &&
		scripts.xjs === true &&
		scripts.moduleCase === true,
	JSON.stringify(scripts),
);
ok(
	'a non-JavaScript type does not run',
	scripts.plain === undefined,
	JSON.stringify(scripts.plain),
);

const real = await page.evaluate(() => {
	const doc = window.__el.contentDocument;
	const get = (id, name) =>
		Element.prototype.getAttribute.call(doc.getElementById(id), name);
	return {
		l1: get('l1', 'href'),
		l2: get('l2', 'href'),
		l3: get('l3', 'href'),
		l4: get('l4', 'href'),
		l5: get('l5', 'href'),
		l6: get('l6', 'href'),
		g1: get('g1', 'href'),
		p1: get('p1', 'xlink:href'),
		f1: get('f1', 'href'),
		sa: get('sa', 'href'),
		ss: get('ss', 'href'),
	};
});
// the JS route carries the script type: /stomp/<id>/js:generic/, /stomp/<id>/js:genericModule/
const route = (value, kind) =>
	typeof value === 'string' && new RegExp(`/stomp/[\\w-]+/${kind}`).test(value);
ok(
	'link rel tokens and as decide the route',
	route(real.l1, 'css/') &&
		route(real.l2, 'binary/') &&
		route(real.l3, 'js:genericModule/') &&
		route(real.l4, 'js:generic/') &&
		route(real.l5, 'css/') &&
		route(real.l6, 'binary/'),
	JSON.stringify({
		l1: real.l1,
		l2: real.l2,
		l3: real.l3,
		l4: real.l4,
		l5: real.l5,
		l6: real.l6,
	}),
);
ok(
	'SVG gradients, patterns and filters route their href',
	route(real.g1, 'binary/') &&
		route(real.p1, 'binary/') &&
		route(real.f1, 'binary/'),
	JSON.stringify({ g1: real.g1, p1: real.p1, f1: real.f1 }),
);
ok(
	'an SVG link navigates through the proxy and an SVG script is routed as a script',
	route(real.sa, 'html/') && route(real.ss, 'js:generic/'),
	JSON.stringify({ sa: real.sa, ss: real.ss }),
);
await done(browser);
