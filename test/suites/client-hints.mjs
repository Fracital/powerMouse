// Client hints between the real origins (src/server/clientHints.ts),
// compared with Chrome per request in both modes. Every scenario gets two
// recorders of its own, site A on 127.0.0.1 and site B on localhost (both
// potentially trustworthy, so hints go to them), on fresh ports for every
// run, so Chrome's kept Accept-CH and the worker's start empty. A recorder
// answers with the Accept-CH, Critical-CH and Permissions-Policy a page's
// query names and keeps, per request key, the hints that came and their
// order. Natively the scenario runs top-level in a fresh context; through
// the proxy from the demo's address bar, the next page in the same tab.
// The checks: the same hints per request (the values too, but the volatile
// network estimate), a viewport hint equal to the requesting document's own
// viewport, Chrome's field order for a request with every hint, and as many
// requests as Chrome made (a Critical-CH retry is one more).
import { createServer } from 'node:http';
import {
	done,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
} from '../lib.mjs';

const ALL = [
	'sec-ch-ua-arch',
	'sec-ch-ua-bitness',
	'sec-ch-ua-full-version',
	'sec-ch-ua-full-version-list',
	'sec-ch-ua-model',
	'sec-ch-ua-platform-version',
	'sec-ch-ua-wow64',
	'sec-ch-ua-form-factors',
	'viewport-width',
	'sec-ch-viewport-width',
	'sec-ch-viewport-height',
	'dpr',
	'sec-ch-dpr',
	'device-memory',
	'sec-ch-device-memory',
	'rtt',
	'downlink',
	'ect',
	'sec-ch-prefers-color-scheme',
	'sec-ch-prefers-reduced-motion',
	'sec-ch-prefers-reduced-transparency',
].join(', ');
const HINT =
	/^(sec-ch-|viewport-width$|dpr$|device-memory$|rtt$|downlink$|ect$|save-data$|width$)/;
// values that move between two loads natively (Chrome's network estimate)
const VOLATILE = new Set(['rtt', 'downlink']);
const VIEWPORT = new Set([
	'viewport-width',
	'sec-ch-viewport-width',
	'sec-ch-viewport-height',
]);
const GIF = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');

/** two recorders and the pages of one scenario */
async function sites(pages) {
	const log = new Map();
	const handler = (site) => (req, res) => {
		const url = new URL(req.url, 'http://x/');
		const key = url.searchParams.get('k');
		if (key) {
			const names = req.rawHeaders
				.filter((_, i) => i % 2 === 0)
				.map((name) => name.toLowerCase())
				.filter((name) => name !== 'host' && name !== 'connection');
			const values = {};
			for (let i = 0; i < req.rawHeaders.length; i += 2) {
				const name = req.rawHeaders[i].toLowerCase();
				if (HINT.test(name)) values[name] = req.rawHeaders[i + 1];
			}
			const entry = log.get(key) ?? { count: 0 };
			entry.count++;
			entry.order = names.join(' ');
			entry.hints = names.filter((name) => HINT.test(name)).sort();
			entry.values = values;
			entry.query = Object.fromEntries(url.searchParams);
			log.set(key, entry);
		}
		const ach = url.searchParams.get('ach');
		if (ach !== null) res.setHeader('accept-ch', ach === 'all' ? ALL : ach);
		const crit = url.searchParams.get('crit');
		if (crit !== null) res.setHeader('critical-ch', crit);
		const pp = url.searchParams.get('pp');
		if (pp !== null) res.setHeader('permissions-policy', pp);
		if (url.pathname.endsWith('.gif')) {
			res.setHeader('content-type', 'image/gif');
			res.end(GIF);
			return;
		}
		res.setHeader('content-type', 'text/html; charset=utf-8');
		const page = pages[url.pathname.slice(1)];
		res.end(page ? page(origins) : '');
		void site;
	};
	const a = createServer(handler('a'));
	const b = createServer(handler('b'));
	// every interface: localhost may resolve to ::1 for the demo's wisp
	await new Promise((resolve) => a.listen(0, resolve));
	await new Promise((resolve) => b.listen(0, resolve));
	const origins = {
		a: `http://127.0.0.1:${a.address().port}`,
		b: `http://localhost:${b.address().port}`,
	};
	return {
		...origins,
		log,
		close: () => {
			a.close();
			b.close();
		},
	};
}

const img = (src) => `<img src="${src}">`;
// the document's own viewport, sent as an image it makes once laid out:
// its viewport hints must name the same
const viewportBeacon = (key) =>
	`<script>addEventListener('load', () => setTimeout(() => { new Image().src = '/vp.gif?k=${key}&w=' + innerWidth + '&h=' + innerHeight; }, 50));</script>`;
const frame = (src, allow) =>
	`<iframe${allow !== undefined ? ` allow="${allow}"` : ''} src="${src}"></iframe>`;
const enc = encodeURIComponent;

/**
 * A scenario: pages served by its recorders, the steps (URLs from the
 * origins), the request keys every run must have recorded before it is
 * read, and the keys whose full field order is compared.
 */
const SCENARIOS = [
	{
		name: 'a top-level Accept-CH: its own subresources at once, the next navigation, never another site',
		pages: {
			first: ({ a, b }) =>
				img(`${a}/i.gif?k=a1`) +
				img(`${b}/i.gif?k=b1`) +
				frame(`${b}/bframe?k=bf1&n=1`) +
				frame(`${a}/aframe?k=af1&n=1`) +
				viewportBeacon('vp1'),
			second: ({ a, b }) =>
				img(`${a}/i.gif?k=a2`) +
				img(`${b}/i.gif?k=b2`) +
				frame(`${b}/bframe?k=bf2&n=2`) +
				frame(`${a}/aframe?k=af2&n=2`) +
				viewportBeacon('vp2'),
			bframe: ({ b }) =>
				`<script>document.write('<img src="${b}/i.gif?k=bfi' + new URLSearchParams(location.search).get('n') + '">')</script>`,
			aframe: ({ a }) =>
				`<script>document.write('<img src="${a}/i.gif?k=afi' + new URLSearchParams(location.search).get('n') + '">')</script>`,
		},
		steps: ({ a }) => [`${a}/first?k=nav1&ach=all`, `${a}/second?k=nav2`],
		keys: [
			'nav1',
			'a1',
			'b1',
			'bf1',
			'af1',
			'nav2',
			'a2',
			'b2',
			'bf2',
			'af2',
			'vp1',
			'vp2',
			'bfi2',
			'afi2',
		],
		order: ['a2', 'nav2'],
	},
	{
		name: 'Permissions-Policy delegates hints to another site, its frames follow their own',
		pages: {
			top: ({ a, b }) =>
				img(`${a}/i.gif?k=a1`) +
				img(`${b}/i.gif?k=b1`) +
				frame(`${b}/bframe?k=bf1`) +
				frame(`${b}/off?k=bf2&pp=${enc('ch-ua-arch=()')}`) +
				frame(`${b}/back?k=bf3&pp=${enc(`ch-ua-arch=(self "${a}")`)}`),
			bframe: ({ b }) => img(`${b}/i.gif?k=bfi1`),
			off: ({ b }) => img(`${b}/i.gif?k=bfi2`),
			back: ({ a }) => img(`${a}/i.gif?k=bfi3`),
		},
		steps: ({ a, b }) => [
			`${a}/top?k=nav1&ach=all&pp=${enc(`ch-ua-arch=*, ch-viewport-width=(self "${b}"), ch-dpr=(self "${b}")`)}`,
		],
		keys: ['nav1', 'a1', 'b1', 'bf1', 'bf2', 'bf3', 'bfi1', 'bfi2', 'bfi3'],
	},
	{
		name: 'Critical-CH: the navigation is made again once with the hints',
		pages: { crit: ({ a }) => img(`${a}/i.gif?k=a1`) },
		steps: ({ a }) => [
			`${a}/crit?k=nav1&ach=${enc('sec-ch-ua-arch, dpr, sec-ch-viewport-width')}&crit=sec-ch-ua-arch`,
		],
		keys: ['nav1', 'a1'],
	},
	{
		name: 'a meta Accept-CH counts for its own document only, a scripted one from then on',
		pages: {
			meta: ({ a }) =>
				`<meta http-equiv="Accept-CH" content="sec-ch-ua-arch, dpr, viewport-width">` +
				img(`${a}/i.gif?k=a1`) +
				frame(`${a}/aframe?k=af1`),
			aframe: ({ a }) => img(`${a}/i.gif?k=afi1`),
			scripted: ({ a }) =>
				`<script>const m = document.createElement('meta'); m.httpEquiv = 'Accept-CH'; m.content = 'sec-ch-ua-bitness'; document.head.append(m); setTimeout(() => { new Image().src = '${a}/late.gif?k=late'; }, 100);</script>`,
			after: () => '',
		},
		steps: ({ a }) => [
			`${a}/meta?k=nav1`,
			`${a}/scripted?k=nav2`,
			`${a}/after?k=nav3`,
		],
		keys: ['nav1', 'a1', 'af1', 'afi1', 'nav2', 'late', 'nav3'],
	},
	{
		name: 'delegate-ch delegates hints to another site, a scripted one does nothing',
		pages: {
			one: () => '',
			top: ({ a, b }) =>
				`<meta http-equiv="delegate-ch" content="sec-ch-ua-arch ${b}; sec-ch-dpr ${b}">` +
				img(`${a}/i.gif?k=a1`) +
				img(`${b}/i.gif?k=b1`) +
				frame(`${b}/bframe?k=bf1`) +
				frame(`${a}/aframe?k=af1`) +
				`<script>setTimeout(() => { new Image().src = '${b}/late.gif?k=late'; }, 100);</script>`,
			bframe: ({ b }) => img(`${b}/i.gif?k=bfi1`),
			aframe: ({ a }) => img(`${a}/i.gif?k=afi1`),
			scripted: ({ b }) =>
				`<script>const m = document.createElement('meta'); m.httpEquiv = 'delegate-ch'; m.content = 'sec-ch-ua-arch ${b}'; document.head.append(m); setTimeout(() => { new Image().src = '${b}/late.gif?k=late2'; }, 100);</script>`,
		},
		steps: ({ a }) => [
			`${a}/one?k=nav0&ach=sec-ch-ua-arch`,
			`${a}/top?k=nav1`,
			`${a}/scripted?k=nav2`,
		],
		keys: [
			'nav0',
			'nav1',
			'a1',
			'b1',
			'bf1',
			'af1',
			'bfi1',
			'afi1',
			'late',
			'nav2',
			'late2',
		],
	},
	{
		name: "a frame's Accept-CH is not kept",
		pages: {
			top: ({ b }) => frame(`${b}/f?k=bf1&ach=sec-ch-ua-arch`),
			f: ({ b }) => img(`${b}/i.gif?k=bfi1`),
			topb: () => '',
		},
		steps: ({ a, b }) => [`${a}/top?k=nav1`, `${b}/topb?k=nav2`],
		keys: ['nav1', 'bf1', 'bfi1', 'nav2'],
	},
	{
		name: "an iframe's allow attribute delegates hints to its frame",
		pages: {
			one: () => '',
			top: ({ a, b }) =>
				frame(`${b}/f?k=bf1`, 'ch-ua-arch; ch-dpr') +
				frame(`${b}/g?k=bf2`, `ch-ua-arch ${a}`) +
				`<script>const f = document.createElement('iframe'); f.allow = 'ch-ua-arch'; f.src = '${b}/h?k=bf3'; document.body.append(f);</script>`,
			f: ({ b }) => img(`${b}/i.gif?k=bfi1`),
			g: ({ b }) => img(`${b}/i.gif?k=bfi2`),
			h: ({ b }) => img(`${b}/i.gif?k=bfi3`),
		},
		steps: ({ a }) => [
			`${a}/one?k=nav0&ach=${enc('sec-ch-ua-arch, dpr')}`,
			`${a}/top?k=nav1`,
		],
		keys: ['nav0', 'nav1', 'bf1', 'bf2', 'bf3', 'bfi1', 'bfi2', 'bfi3'],
	},
];

async function recorded(log, keys) {
	for (let i = 0; i < 120; i++) {
		if (keys.every((key) => log.has(key))) break;
		await sleep(250);
	}
	// a Critical-CH retry, a late image
	await sleep(600);
}

async function runNative(browser, scenario) {
	const site = await sites(scenario.pages);
	const page = await browser.newPage({
		viewport: { width: 1280, height: 800 },
	});
	for (const url of scenario.steps(site)) {
		await page.goto(url).catch(() => {});
		await sleep(400);
	}
	await recorded(site.log, scenario.keys);
	await page.context().close();
	site.close();
	return site.log;
}

async function runProxied(browser, base, scenario) {
	const site = await sites(scenario.pages);
	const tab = await openDemo(browser, base);
	const steps = scenario.steps(site);
	await submitLanding(tab, steps[0]);
	for (const url of steps.slice(1)) {
		// the page before has made its requests
		await sleep(1500);
		await submitOmni(tab, url);
	}
	await recorded(site.log, scenario.keys);
	await tab.context().close();
	site.close();
	return site.log;
}

function compare(mode, scenario, native, proxied) {
	const problems = [];
	for (const key of scenario.keys) {
		const n = native.get(key);
		const p = proxied.get(key);
		if (!n) {
			problems.push(`${key}: natively never requested`);
			continue;
		}
		if (!p) {
			problems.push(`${key}: never requested through the proxy`);
			continue;
		}
		if (n.count !== p.count)
			problems.push(`${key}: ${p.count} requests, natively ${n.count}`);
		if (n.hints.join(' ') !== p.hints.join(' '))
			problems.push(
				`${key}: hints [${p.hints.join(' ')}], natively [${n.hints.join(' ')}]`,
			);
		for (const [name, value] of Object.entries(n.values))
			if (
				!VOLATILE.has(name) &&
				!VIEWPORT.has(name) &&
				p.values[name] !== undefined &&
				p.values[name] !== value
			)
				problems.push(`${key}: ${name} ${p.values[name]}, natively ${value}`);
		// a viewport hint names the document's own viewport (the proxied
		// page's is its frame's)
		if (key.startsWith('vp'))
			for (const [run, entry] of [
				['natively', n],
				['proxied', p],
			]) {
				const width = entry.values['sec-ch-viewport-width'];
				const height = entry.values['sec-ch-viewport-height'];
				if (width !== entry.query.w || height !== entry.query.h)
					problems.push(
						`${key} ${run}: viewport ${width}x${height}, the document's ${entry.query.w}x${entry.query.h}`,
					);
			}
	}
	for (const key of scenario.order ?? []) {
		const n = native.get(key)?.order;
		const p = proxied.get(key)?.order;
		if (n !== p) problems.push(`${key}: order\n    ${p}\n  natively\n    ${n}`);
	}
	ok(`${mode}: ${scenario.name}`, !problems.length, problems.join('; '));
}

const browser = await launch();
const only = process.env.ONLY;
for (const scenario of SCENARIOS) {
	if (only && !scenario.name.includes(only)) continue;
	const native = await runNative(browser, scenario);
	for (const [mode, base] of [
		['same-origin', PROXY],
		['isolated', HOST],
	]) {
		const proxied = await runProxied(browser, base, scenario);
		compare(mode, scenario, native, proxied);
	}
}
await done(browser);
