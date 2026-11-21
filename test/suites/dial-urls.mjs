// Dialing (just call stomp, src/controller/justCallStomp.ts) as the browser
// sees it: what a dialed tab's frames are to the browser, and what is there
// of the dial at all when a host did not opt in.
//
// Dial mode (the demo's ?mode=just-call-stomp: its controller has
// `dialing: true`, its scope and its call page are the server's neutral
// names, STOMP_DIAL_DIRECTORY): a walk through three depths of frames, a
// navigation inside a nested frame, a typed address, a scroll, a pushState,
// a link to another site whose frame is made by script, the browser's Back
// and Forward, a reload from inside the page, a reload of the host and a
// redirect. After every step each frame's src (the host realm's
// getAttribute, AGENTS.md Verification 4) and real location (the host
// realm's view of the window, and the browser's own, Playwright's
// frame.url()), and every navigation request of a frame the browser made,
// are the call page and nothing else: no destination, no route, no word of
// the proxy, one URL for the tab's frames and one per depth below them
// (`?1`, `?2`), the same at every step. A step back restores the scroll
// the document told the host over its port (the host reads no frame's
// window).
//
// The call's token, past the hooks (an isolated world in a called document
// holds the browser's own DOM and postMessage): a frame of its own on the
// call page posted forged tokens, a message from a window that is not the
// call page's parent, a fetch of a route with a forged token, a token
// spent twice, a token for another route: none is answered. The control: a
// token the controller minted is.
//
// Default mode (the demo without the mode): the controller refuses a
// token and justCallStomp, the call page's URL is no page of the worker's
// (the demo's server answers it, 404), and a page's request that carries the
// call's headers is a request like any other.
import {
	done,
	evaluateIsolated,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
} from '../lib.mjs';

const F = new URL(FIXTURE).port;
const PAGES = `http://127.0.0.1:${F}/pages/`;
const config = await (await fetch(`${PROXY}config.js`)).text();
const DIAL = JSON.parse(
	/window\.STOMP_CONFIG = (.*);\s*$/s.exec(config)[1],
).dial;
const CALL = `${new URL(PROXY).origin}${DIAL.directory}${DIAL.page}`;
// SystemYA's neutral words (scripts/check-neutral-dist.mjs NAME_WORDS), the
// dial's own and the old call page's name
const WORDS =
	/stomp|sysce|epoxy|libcurl|powermouse|adblock|rewriter|proxy|ruffle|flash|swf|unblock|blank|call|dial|route|html\//i;

/** why `url` says more than nothing, or null: the call page at `depth` */
function strayOf(url, depth) {
	if (typeof url !== 'string' || !url) return 'none';
	if (url.includes(`:${F}`) || /jcs-|dial-nest|redirect/.test(url))
		return 'destination';
	let parsed;
	try {
		parsed = new URL(url);
	} catch (error) {
		return 'no URL';
	}
	if (WORDS.test(parsed.pathname + parsed.search + parsed.hash))
		return 'a word';
	const want = depth === 0 ? CALL : `${CALL}?${depth}`;
	return url === want ? null : `not ${want}`;
}

const browser = await launch([], { backForwardCache: true });
const page = await openDemo(browser, `${PROXY}?nopool&mode=just-call-stomp`);
const reports = [];
const requests = [];
page.on('console', (message) => {
	const text = message.text();
	if (!text.startsWith('JCS:')) return;
	try {
		reports.push(JSON.parse(text.slice(4)));
	} catch (error) {
		// cut short
	}
});
page.on('request', (request) => {
	if (request.isNavigationRequest() && request.frame() !== page.mainFrame())
		requests.push(request.url());
});
const waitReport = async (pred, from, timeout = 30000) => {
	for (const start = Date.now(); Date.now() - start < timeout;) {
		const found = reports.slice(from).find(pred);
		if (found) return found;
		await sleep(100);
	}
	return null;
};
const loadOf = (step, from, extra = () => true) =>
	waitReport((r) => r.step === step && r.why === 'load' && extra(r), from);

/** every dialed frame as the host realm reads it: real src and location, by depth */
const tree = () =>
	page.evaluate(() => {
		const get = Element.prototype.getAttribute;
		const all = Document.prototype.querySelectorAll;
		const windowOf = Reflect.getOwnPropertyDescriptor(
			HTMLIFrameElement.prototype,
			'contentWindow',
		).get;
		const out = [];
		const walk = (doc, selector, depth) => {
			for (const element of Reflect.apply(all, doc, [selector])) {
				const entry = {
					depth,
					src: Reflect.apply(get, element, ['src']),
					srcdoc: Reflect.apply(get, element, ['srcdoc']),
				};
				out.push(entry);
				try {
					const win = Reflect.apply(windowOf, element, []);
					entry.href = win.location.href;
					walk(win.document, 'iframe, frame', depth + 1);
				} catch (error) {
					entry.crossOrigin = true;
				}
			}
		};
		walk(document, '#browser iframe', 0);
		return out;
	});

const seen = new Map();
/** the frames at a step: each is the call page of its depth, and was at every step */
async function check(step, depths = 1) {
	await sleep(400);
	const frames = await tree();
	const bad = [];
	for (const frame of frames) {
		const src = frame.src === null ? null : strayOf(frame.src, frame.depth);
		if (src) bad.push(`src ${frame.src} (${src})`);
		if (frame.srcdoc !== null) bad.push('a srcdoc');
		if (frame.crossOrigin) bad.push(`depth ${frame.depth} unreadable`);
		else if (strayOf(frame.href, frame.depth))
			bad.push(`location ${frame.href} (${strayOf(frame.href, frame.depth)})`);
		const urls = seen.get(frame.depth) ?? new Set();
		urls.add(frame.href);
		seen.set(frame.depth, urls);
	}
	// the browser's own view of every frame's location
	for (const frame of page.frames()) {
		if (frame === page.mainFrame()) continue;
		let depth = -1;
		for (let at = frame; at.parentFrame(); at = at.parentFrame()) depth++;
		const why = strayOf(frame.url(), depth);
		if (why && frame.url() !== 'about:blank')
			bad.push(`frame ${frame.url()} (${why})`);
	}
	const reached = Math.max(-1, ...frames.map((frame) => frame.depth)) + 1;
	ok(
		`${step}: every frame's src and location is the call page of its depth, ${depths} deep`,
		!bad.length && reached >= depths,
		bad.slice(0, 4).join('; ') || `${frames.length} frames, ${reached} deep`,
	);
}
const activeFrame = async () => {
	const handle = await page.$('#browser .frame:not(.hidden)');
	return handle ? handle.contentFrame() : null;
};
const inTab = async (fn, arg) => (await activeFrame()).evaluate(fn, arg);

let mark = reports.length;
await submitLanding(page, `${PAGES}dial-nest.html`);
ok(
	'a page with a frame with a frame of its own loads, three depths dialed',
	!!(await loadOf('nest', mark)) &&
		!!(await loadOf('a1', mark)) &&
		!!(await loadOf('child', mark, (r) => r.href.includes('?a1'))),
);
await check('three depths', 3);

mark = reports.length;
{
	const nested = (await activeFrame()).childFrames()[0];
	await nested.evaluate(() => document.getElementById('next').click());
}
ok(
	'a link in the nested frame shows its next document there',
	!!(await loadOf('a2', mark)),
);
await check('a navigation in a nested frame', 2);

mark = reports.length;
await submitOmni(page, `${PAGES}jcs-a2.html`);
ok('a typed address shows its page', !!(await loadOf('a2', mark)));
await inTab(() => scrollTo(0, 700));
await sleep(500);
const left = await inTab(() => scrollY);
await check('a typed address');

mark = reports.length;
await inTab(() => document.getElementById('push').click());
await waitReport((r) => r.step === 'a2' && r.why === 'push', mark);
await check('a pushState');

mark = reports.length;
await inTab(() => document.getElementById('cross').click());
ok(
	'a link to another site shows it, with the frame its script makes',
	!!(await loadOf('b1', mark)) &&
		!!(await loadOf('child', mark, (r) => r.href.includes('?b1'))),
);
await check('another site', 2);

mark = reports.length;
await page.goBack();
ok(
	"the browser's Back shows the pushed entry again",
	!!(await loadOf('a2', mark)),
);
await sleep(600);
const scrolled = await inTab(() => scrollY);
ok(
	'its scroll is where it was left, told over the port and restored by the document',
	Math.abs(scrolled - left) <= 2 && left > 0,
	`${scrolled} (left at ${left}) ${await page.evaluate(() =>
		Object.keys(sessionStorage)
			.filter((key) => key.startsWith('just-call:'))
			.map((key) =>
				JSON.parse(sessionStorage[key]).entries.map((entry) => entry.scroll),
			)
			.join(' | '),
	)}`,
);
await check('Back');

mark = reports.length;
await page.goForward();
ok(
	"the browser's Forward shows the other site again",
	!!(await loadOf('b1', mark)),
);
await check('Forward', 2);

mark = reports.length;
await inTab(() => location.reload());
ok(
	'a reload from inside the page shows it again',
	!!(await loadOf('b1', mark)),
);
await check('a reload of the page', 2);

mark = reports.length;
await page.reload();
await page.waitForFunction(
	() =>
		/^(Ready|Error|Loaded)/.test(document.getElementById('logMsg').textContent),
	null,
	{ timeout: 45000 },
);
ok('a reload of the host shows the tab again', !!(await loadOf('b1', mark)));
await check('a reload of the host', 2);

mark = reports.length;
await submitOmni(
	page,
	`http://127.0.0.1:${F}/redirect?to=${encodeURIComponent(`${PAGES}jcs-a1.html?redirected`)}`,
);
ok(
	'a redirect shows where it went',
	!!(await loadOf('a1', mark, (r) => r.href.includes('?redirected'))),
);
await check('a redirect', 2);

ok(
	"the tab's frames had one URL at every step, and each depth below one",
	[...seen.values()].every((urls) => urls.size === 1),
	JSON.stringify([...seen].map(([depth, urls]) => [depth, [...urls]])),
);
const strayRequests = requests.filter(
	(url) => strayOf(url, 0) && !/^\?\d+$/.test(url.slice(CALL.length)),
);
ok(
	'every frame navigation the browser made was to a call page',
	requests.length > 0 && !strayRequests.length,
	strayRequests.slice(0, 3).join(' ') || `${requests.length} requests`,
);

// the token, past the hooks: an isolated world in the tab's called document
const route = await page.evaluate(
	(url) => window.controller.route(url),
	`${PAGES}jcs-child.html?stolen`,
);
const other = await page.evaluate(
	(url) => window.controller.route(url),
	`${PAGES}jcs-child.html?other`,
);
const granted = await page.evaluate(
	(url) => window.controller.callToken(url),
	route,
);
const twice = await page.evaluate(
	(url) => window.controller.callToken(url),
	route,
);
const elsewhere = await page.evaluate(
	(url) => window.controller.callToken(url),
	other,
);
const tab = await activeFrame();
const attempts = await evaluateIsolated(
	tab,
	async ({ call, route, granted, twice, elsewhere }) => {
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const forged = () =>
			Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
				byte.toString(16).padStart(2, '0'),
			).join('');
		const frame = async () => {
			const raw = document.createElement('iframe');
			raw.src = `${call}?1`;
			document.body.append(raw);
			await new Promise((resolve) => (raw.onload = resolve));
			return raw;
		};
		/** a call as the host makes one: what the port heard */
		const dial = (win, token, routed = route) =>
			new Promise((resolve) => {
				const { port1, port2 } = new MessageChannel();
				const heard = [];
				port1.onmessage = ({ data }) => {
					heard.push(Object.keys(data).join());
					if (data.ready)
						port1.postMessage({
							call: {
								routed,
								type: 'navigate',
								method: 'GET',
								body: null,
								referrer: '',
							},
						});
					if (data.answered || data.failed) resolve(heard.join(' '));
				};
				win.postMessage({ $stomp$call: token }, '*', [port2]);
				setTimeout(() => resolve(heard.join(' ') || 'nothing'), 6000);
			});
		const blank = (win) => ({
			written: win.document.body?.childElementCount ?? 0,
			called: '$stomp$called' in win,
		});
		const out = {};
		const raw = await frame();
		out.forged = await Promise.all(
			Array.from({ length: 5 }, () => dial(raw.contentWindow, forged())),
		);
		out.oldSpoof = await new Promise((resolve) => {
			const { port1, port2 } = new MessageChannel();
			port1.onmessage = () => resolve('heard');
			raw.contentWindow.postMessage({ $stomp$call: 1 }, '*', [port2]);
			setTimeout(() => resolve('nothing'), 2000);
		});
		await sleep(300);
		out.forgedPage = blank(raw.contentWindow);
		// a window that is not its parent: the tab's own window posting into
		// a frame of a frame
		const outer = await frame();
		const inner = outer.contentDocument.createElement('iframe');
		inner.src = `${call}?2`;
		outer.contentDocument.body.append(inner);
		await new Promise((resolve) => (inner.onload = resolve));
		out.notParent = await new Promise((resolve) => {
			const { port1, port2 } = new MessageChannel();
			port1.onmessage = () => resolve('heard');
			inner.contentWindow.postMessage({ $stomp$call: granted }, '*', [port2]);
			setTimeout(() => resolve('nothing'), 2000);
		});
		// a token for another route
		out.elsewhere = await dial((await frame()).contentWindow, elsewhere);
		// the control, then the same token again
		out.granted = await dial((await frame()).contentWindow, granted);
		out.again = await dial((await frame()).contentWindow, granted);
		out.twice = await dial((await frame()).contentWindow, twice);
		return out;
	},
	{ call: CALL, route, granted, twice, elsewhere },
);
// a fetch of the route with the call's headers and a forged token, by the
// document itself: no call (its hooks keep the proxy's own headers off a
// page's request, and the worker would refuse the token). An isolated
// world's own fetch goes past the worker, to the demo's server.
attempts.fetch = await tab.evaluate(async (route) => {
	const forged = Array.from(
		crypto.getRandomValues(new Uint8Array(16)),
		(byte) => byte.toString(16).padStart(2, '0'),
	).join('');
	const response = await fetch(route, {
		headers: { 'x-stomp-call': 'navigate', 'x-stomp-call-token': forged },
	});
	return `${response.status} ${response.headers.has('x-stomp-called-url')}`;
}, route);
console.log(`# ${JSON.stringify(attempts)}`);
ok(
	'a frame of the page on the call page answers no forged token',
	attempts.forged.every((heard) => !/answered/.test(heard)) &&
		!attempts.forgedPage.written &&
		!attempts.forgedPage.called,
	JSON.stringify([attempts.forged, attempts.forgedPage]),
);
ok(
	"the prototype's message (no token) is not heard",
	attempts.oldSpoof === 'nothing',
);
ok(
	"a message from a window that is not the call page's parent is not heard",
	attempts.notParent === 'nothing',
);
ok(
	"a page's fetch of a route with the call's headers is no call",
	/^\d+ false$/.test(attempts.fetch) && !attempts.fetch.startsWith('0'),
	attempts.fetch,
);
ok(
	'a token for another route is refused',
	/failed/.test(attempts.elsewhere) && !/answered/.test(attempts.elsewhere),
	attempts.elsewhere,
);
ok(
	'a token the controller minted is answered (the control)',
	/answered/.test(attempts.granted),
	attempts.granted,
);
ok(
	'a token spent once is refused the second time',
	/failed/.test(attempts.again) && !/answered/.test(attempts.again),
	attempts.again,
);
ok(
	'a second token for the same route is a call of its own',
	/answered/.test(attempts.twice),
	attempts.twice,
);
const dialErrors = [...page.errors];
await page.close();

// default mode: no dial surface
const plain = await openDemo(browser, `${PROXY}?nopool`);
const defaultPage = `${new URL(PROXY).origin}/stomp/k3v9.html`;
const served = await plain.evaluate(
	async (urls) => {
		const out = [];
		for (const url of urls) {
			const frame = document.createElement('iframe');
			frame.src = url;
			document.body.append(frame);
			await new Promise((resolve) => (frame.onload = resolve));
			let text;
			try {
				text = frame.contentDocument.documentElement.outerHTML;
			} catch (error) {
				text = 'unreadable';
			}
			out.push(text.includes('$stomp$call'));
			frame.remove();
		}
		return out;
	},
	[defaultPage, `${new URL(PROXY).origin}/stomp/${DIAL.page}`],
);
ok(
	"the call page's URL is no page of the worker's",
	served.every((page) => page === false),
	JSON.stringify(served),
);
const statuses = await Promise.all(
	[defaultPage].map((url) => fetch(url).then((r) => r.status)),
);
ok(
	"the host's server has nothing there either",
	statuses.every((s) => s === 404),
	String(statuses),
);
await submitLanding(plain, `${PAGES}jcs-child.html?plain`);
let plainFrame = null;
for (let i = 0; i < 60 && !plainFrame; i++) {
	await sleep(250);
	const handle = await plain.$('#browser .frame:not(.hidden)');
	const frame = handle && (await handle.contentFrame());
	const title =
		frame && (await frame.evaluate(() => document.title).catch(() => ''));
	if (title === 'JCS child') plainFrame = frame;
}
const refused = await plain.evaluate(async (url) => {
	const out = {};
	const routed = await window.controller.route(url);
	try {
		await window.controller.callToken(routed);
		out.token = 'minted';
	} catch (error) {
		out.token = 'refused';
	}
	try {
		await window.StompController.justCallStomp(
			window.controller.frames[0],
			url,
		);
		out.justCall = 'ran';
	} catch (error) {
		out.justCall = /dialing/.test(error.message) ? 'refused' : error.message;
	}
	return out;
}, `${PAGES}jcs-child.html`);
ok(
	'without `dialing` the controller gets no token and justCallStomp throws',
	refused.token === 'refused' && refused.justCall === 'refused',
	JSON.stringify(refused),
);
const asked = plainFrame
	? await plainFrame.evaluate(async () => {
			const response = await fetch(location.href, {
				headers: {
					'x-stomp-call': 'navigate',
					'x-stomp-call-token': '0'.repeat(32),
				},
			});
			return `${response.status} ${response.headers.has('x-stomp-called-url')}`;
		})
	: 'no frame';
ok(
	"a page's request with the call's headers is a request like any other",
	asked === '200 false',
	asked,
);
await done(browser, [...dialErrors, ...plain.errors]);
