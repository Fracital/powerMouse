// Links and the URL attributes around them: an <area href> is routed like
// <a href>, formaction, input[src], poster, track, object[data] and
// imagesrcset are routed, URL properties read back as written, an anchor's
// URL parts are the link's own. An <area href> reads
// back as the page wrote it, and a click on it navigates the frame through
// the proxy. Same-origin mode, where a world of the frame's own reads its
// real attributes.
import {
	done,
	evaluateIsolated,
	evaluateQuietly,
	FIXTURE,
	launch,
	ok,
	PROXY,
	sleep,
} from '../lib.mjs';

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
	const frame = window.controller.createFrame(element);
	await frame.go(`${fixture}pages/links.html`);
}, FIXTURE);
await sleep(2000);
const newest = () =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));

// the frame of the iframe this page made (a site pool shows it from another
// origin, in another process)
const shown = async () =>
	(await page.evaluateHandle(() => window.__el)).asElement().contentFrame();
// the real attribute, read in a world of the frame's own that no hook
// reaches (the frame's own getAttribute answers with what the page wrote)
const real = await evaluateIsolated(await shown(), () => {
	const get = (id) => document.getElementById(id).getAttribute('href');
	return { area: get('area'), a: get('a') };
});
// (a link's route names its context, not a controller: src/visited.ts)
ok(
	'area[href] is routed like a[href]',
	/\/stomp\/~\/[^/?#]+#/.test(real.area) && /\/stomp\/~\/[^/?#]+#/.test(real.a),
	JSON.stringify(real),
);
const seen = await newest().evaluate(() => {
	const area = document.getElementById('area');
	return {
		attribute: area.getAttribute('href'),
		href: area.href,
		protocol: area.protocol,
	};
});
ok(
	'the page reads the href it wrote',
	seen.attribute === 'hist-2.html?from=area#f' &&
		seen.href === `${FIXTURE}pages/hist-2.html?from=area#f`,
	JSON.stringify(seen),
);

// the URL attributes scramjet rewrites and STomp did not, read in a world no
// hook reaches: every one must be routed
const attributes = await evaluateIsolated(await shown(), () => {
	const get = (id, name) => document.getElementById(id).getAttribute(name);
	return {
		formaction: get('formaction', 'formaction'),
		inputformaction: get('inputformaction', 'formaction'),
		inputsrc: get('inputsrc', 'src'),
		poster: get('video', 'poster'),
		track: get('track', 'src'),
		object: get('object', 'data'),
		imagesrcset: get('preload', 'imagesrcset'),
	};
});
const routed = (value) =>
	typeof value === 'string' && value.includes('/stomp/');
// an object's real data is a blob: URL of the proxied copy, or absent while
// it loads (Chrome never routes an object's load through the worker)
const proxiedObject = (value) =>
	value === null || (typeof value === 'string' && value.startsWith('blob:'));
ok(
	'formaction, input[src], poster, track, object[data] and imagesrcset are routed',
	Object.entries(attributes).every(([name, value]) =>
		name === 'object' ? proxiedObject(value) : routed(value),
	),
	JSON.stringify(
		Object.fromEntries(
			Object.entries(attributes).filter(([name, v]) =>
				name === 'object' ? !proxiedObject(v) : !routed(v),
			),
		),
	),
);
const readBack = await newest().evaluate(() => {
	const $ = (id) => document.getElementById(id);
	return {
		formaction: $('formaction').formAction,
		poster: $('video').poster,
		track: $('track').src,
		object: $('object').data,
		inputsrc: $('inputsrc').src,
		imagesrcset: $('preload').imageSrcset,
	};
});
ok(
	'the page reads those URL properties as it wrote them',
	readBack.formaction === `${FIXTURE}landed?formaction` &&
		readBack.poster === `${FIXTURE}pages/sprite.svg` &&
		readBack.track === `${FIXTURE}pages/hdr.json` &&
		readBack.object === `${FIXTURE}pages/keep.html` &&
		readBack.inputsrc === `${FIXTURE}pages/sprite.svg` &&
		readBack.imagesrcset === 'sprite.svg 1x, sprite.svg 2x',
	JSON.stringify(readBack),
);

// URL parts of a link are the link's, not the page's
const parts = await newest().evaluate(() => {
	const a = document.getElementById('a');
	return {
		href: a.href,
		protocol: a.protocol,
		host: a.host,
		hostname: a.hostname,
		port: a.port,
		pathname: a.pathname,
		search: a.search,
		hash: a.hash,
		origin: a.origin,
		text: String(a),
	};
});
const fixture = new URL(FIXTURE);
ok(
	'anchor URL parts come from the link',
	parts.href === `${fixture.origin}/pages/hist-2.html?q=1#frag` &&
		parts.protocol === fixture.protocol &&
		parts.host === fixture.host &&
		parts.hostname === fixture.hostname &&
		parts.port === fixture.port &&
		parts.pathname === '/pages/hist-2.html' &&
		parts.search === '?q=1' &&
		parts.hash === '#frag' &&
		parts.origin === fixture.origin &&
		parts.text === parts.href,
	JSON.stringify(parts),
);
const set = await newest().evaluate(() => {
	const a = document.getElementById('a');
	a.pathname = '/pages/hist-1.html';
	a.search = '?s=2';
	return { href: a.href, attribute: a.getAttribute('href') };
});
ok(
	'setting a URL part updates the link, routed',
	set.href === `${fixture.origin}/pages/hist-1.html?s=2#frag` &&
		set.attribute === `${fixture.origin}/pages/hist-1.html?s=2#frag`,
	JSON.stringify(set),
);

// a URL attribute changed after it was routed takes effect: setAttribute,
// the property, and on an image
const realHref = async () =>
	evaluateIsolated(await shown(), () =>
		document.getElementById('a').getAttribute('href'),
	);
const realBefore = await realHref();
const updated = await newest().evaluate(() => {
	const a = document.getElementById('a');
	a.setAttribute('href', '/pages/hist-2.html?set=1');
	const viaAttribute = [a.getAttribute('href'), a.href];
	a.href = '/pages/hist-2.html?prop=1';
	const viaProperty = [a.getAttribute('href'), a.href];
	const img = document.querySelector('img');
	img.src = 'hdr.json';
	return { viaAttribute, viaProperty, img: [img.getAttribute('src'), img.src] };
});
const realAfter = await realHref();
ok(
	'a link changed after routing reads back and is routed again',
	updated.viaAttribute[0] === '/pages/hist-2.html?set=1' &&
		updated.viaAttribute[1] === `${fixture.origin}/pages/hist-2.html?set=1` &&
		updated.viaProperty[0] === '/pages/hist-2.html?prop=1' &&
		updated.viaProperty[1] === `${fixture.origin}/pages/hist-2.html?prop=1` &&
		/\/stomp\/~\/[^/?#]+$/.test(realAfter) &&
		realAfter !== realBefore,
	JSON.stringify({ ...updated, realAfter: realAfter.slice(0, 50) }),
);
ok(
	'an image source changed after routing reads back',
	updated.img[0] === 'hdr.json' &&
		updated.img[1] === `${fixture.origin}/pages/hdr.json`,
	JSON.stringify(updated.img),
);

await newest().evaluate(() => document.getElementById('area').click());
await sleep(1500);
const after = newest();
let title;
try {
	title = after ? await after.title() : 'gone';
} catch (error) {
	title = `error ${error.message.slice(0, 40)}`;
}
ok(
	'a click on the area navigates the frame through the proxy',
	page.url().split('#')[0] === PROXY && title === 'HIST 2',
	`host ${page.url()} frame ${title} url ${after?.url().slice(0, 60)}`,
);
// a target that names a frame of the page: the browser navigates that frame,
// a link and window.open alike; the host hears no `open`
// (the page's state and its frame's title are read in the frame, with no
// user activation: a site pool shows it from another origin than this
// page's)
const namedElement = await page.evaluateHandle(async (fixture) => {
	window.__opens = [];
	window.controller.addEventListener('open', (event) =>
		window.__opens.push(event.detail.url),
	);
	const element = document.createElement('iframe');
	document.body.append(element);
	const frame = window.controller.createFrame(element);
	await frame.go(`${fixture}pages/named-target.html`);
	return element;
}, FIXTURE);
const namedState = () =>
	namedElement
		.asElement()
		.contentFrame()
		.then((frame) => frame && evaluateQuietly(frame, 'window.__named ?? null'))
		.then(
			(value) => value ?? null,
			() => null,
		);
for (let i = 0; i < 40; i++) {
	await sleep(250);
	if ((await namedState())?.done) break;
}
const namedFrame = await namedElement.asElement().contentFrame();
const named = {
	state: await namedState(),
	innerTitle: namedFrame
		? await evaluateIsolated(
				namedFrame,
				() =>
					document.getElementById('slot')?.contentDocument?.title ??
					'unreadable',
			).catch(() => 'unreadable')
		: 'unreadable',
	opens: await page.evaluate(() => window.__opens),
};
ok(
	'a link and window.open aimed at a named frame of the page navigate that frame, not a new tab',
	named.state?.linkLoaded === true &&
		named.state?.openLoaded === true &&
		named.innerTitle === 'HIST 2' &&
		named.opens.length === 0,
	JSON.stringify(named),
);

// a frame whose document a javascript: URL's string makes: it runs injected,
// so it sees this page as its top, fetches through the proxy (from a document
// no service worker controls) and posts to this page rather than the host
const jsurlElement = await page.evaluateHandle(async (fixture) => {
	window.__hostMessages = [];
	addEventListener('message', (event) => {
		if (event.data && event.data.jsurl !== undefined)
			window.__hostMessages.push(event.data);
	});
	const element = document.createElement('iframe');
	document.body.append(element);
	const frame = window.controller.createFrame(element);
	await frame.go(`${fixture}pages/jsurl-frame.html`);
	return element;
}, FIXTURE);
const jsurlState = () =>
	jsurlElement
		.asElement()
		.contentFrame()
		.then((frame) => frame && evaluateQuietly(frame, 'window.__jsurl ?? null'))
		.then(
			(value) => value ?? null,
			() => null,
		);
for (let i = 0; i < 40; i++) {
	await sleep(200);
	if ((await jsurlState())?.done) break;
}
const jsurl = {
	page: await jsurlState(),
	hostMessages: await page.evaluate(() => window.__hostMessages),
};
ok(
	'a javascript: URL frame runs injected: its top is the page, its fetch goes through, its message reaches the page',
	jsurl.page?.message?.jsurl === true &&
		jsurl.page?.message?.ok === true &&
		jsurl.hostMessages.length === 0,
	JSON.stringify(jsurl),
);

await done(browser);
