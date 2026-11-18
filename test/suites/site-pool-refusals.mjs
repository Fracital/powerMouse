// The site pool's code that runs on an event is a deferred part of the
// document bundle (src/inject/dom/siteAcross.ts, navigateOther.ts): a post
// to and the stand-in of a window of another slot, a link and a form aimed
// at one, a navigation of one. A document of a slot takes the parts from
// its top's text, a frame of another slot than its page's from its slot's
// agent (src/controller/slotLibrary.ts), and a realm with neither from the
// library's file: here a pool whose slots serve that file (through a front
// of the demo server) with a parts statement that throws, so neither the
// agent nor any document of the pool can have them, beside a pool whose
// fronts pass the file as it is (a slot is any origin a controller's
// sitePool names: nothing of the proxy's changes for the suite).
//
// A page of one site with its frame of the other, each shown from a slot of
// its own: the page holds the frame's window while the frame is on its
// initial about:blank, then the frame shows the other site, and
// - the page posts to that window, reads it (frames[0]) and navigates it
//   (`held.location = url`);
// - the frame reads its parent and posts to it;
// - a sandboxed frame of the page's site (allow-scripts allow-same-origin)
//   does the same with its own frame of the other site: navigates it;
// - the frame's link and form aimed at the top are clicked, and the form's
//   submit() is called.
// With the parts each answers as natively. Without them the posts, the
// reads and the navigations throw, nothing is posted (a listener every
// document gets before any script of its own counts the browser's message
// events) and nothing navigates; the clicks and the submit event navigate
// nothing (their default is prevented), and submit() throws.
import { createServer, request } from 'node:http';
import {
	done,
	FIXTURE,
	launch,
	ok,
	PORT,
	PROXY,
	REWRITER,
	sleep,
} from '../lib.mjs';

const A = FIXTURE;
const B = FIXTURE.replace('127.0.0.1', 'localhost');
const PAGE = 'pages/site-pool-refusals.html';
const NO_PARTS = '__stompDeferred=function(){throw new Error("no parts")};';

/** a server on a free port of 127.0.0.1, closed with the suite */
async function listen(server) {
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	return `http://127.0.0.1:${server.address().port}`;
}
/** whether each library file a broken front served had a parts statement it replaced */
const fronted = [];
/**
 * The demo server through a front of another port, with the header every
 * slot sends; with `broken`, the rewriter library's file has a parts
 * statement that throws in place of its own (build.js writes it after a
 * line break, before the passkeys' statement)
 */
async function front(broken) {
	const server = createServer((req, res) => {
		const library = broken && /\/rewriterLib\.js(\?|$)/.test(req.url);
		const headers = { ...req.headers };
		if (library) {
			delete headers['accept-encoding'];
			delete headers['if-none-match'];
			delete headers['if-modified-since'];
		}
		const upstream = request(
			{
				host: '127.0.0.1',
				port: Number(PORT),
				path: req.url,
				method: req.method,
				headers,
			},
			(answer) => {
				const out = { ...answer.headers, 'origin-agent-cluster': '?1' };
				if (!library || answer.statusCode !== 200) {
					res.writeHead(answer.statusCode, out);
					answer.pipe(res);
					return;
				}
				const chunks = [];
				answer.on('data', (chunk) => chunks.push(chunk));
				answer.on('end', () => {
					const file = Buffer.concat(chunks).toString();
					const start = file.lastIndexOf('\n__stompDeferred=');
					const end = file.lastIndexOf('\n__stompPasskeys=');
					const body =
						start === -1 || end < start
							? file
							: `${file.slice(0, start + 1)}${NO_PARTS}${file.slice(end)}`;
					fronted.push(start !== -1 && end > start);
					delete out.etag;
					delete out['content-encoding'];
					out['content-length'] = Buffer.byteLength(body);
					res.writeHead(200, out);
					res.end(body);
				});
			},
		);
		upstream.on('error', () => res.destroy());
		req.pipe(upstream);
	});
	return listen(server);
}
const good = [await front(false), await front(false)];
const broken = [await front(true), await front(true)];

const browser = await launch();
const context = await browser.newContext();
// before any script of each document, the inject's included: every message
// the browser dispatches to it that carries one of the suite's keys (opening
// a document removes the window's listeners: after the shell's open() it is
// added again, before the inject's own)
await context.addInitScript(() => {
	const raw = [];
	Reflect.defineProperty(window, '__sprRaw', { value: raw });
	const listener = (event) => {
		try {
			const text = JSON.stringify(event.data);
			if (typeof text === 'string' && text.includes('spr-'))
				raw.push(text.slice(0, 300));
		} catch (error) {
			// a message JSON cannot write
		}
	};
	const listen = () => addEventListener('message', listener, true);
	listen();
	const open = Document.prototype.open;
	Document.prototype.open = function (...args) {
		const opened = Reflect.apply(open, this, args);
		if (this === document) listen();
		return opened;
	};
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

/**
 * The document `where` (a frame element handle, or a function answering a
 * frame) shows once its __spr.role is `role` and its search passes `test`
 */
async function documentOf(where, role, test = () => true, ms = 30000) {
	const until = Date.now() + ms;
	for (;;) {
		const frame = await Promise.resolve(
			typeof where === 'function' ? where() : where.contentFrame(),
		).catch(() => null);
		const seen = await frame
			?.evaluate(() => window.__spr && [window.__spr.role, window.__spr.search])
			.catch(() => null);
		if (seen && seen[0] === role && test(seen[1])) return frame;
		if (Date.now() > until) return null;
		await sleep(100);
	}
}
/** what `frame`'s __spr answers to `method(...args)`, called as the page's own code */
const call = (frame, method, ...args) =>
	frame
		.evaluate(({ method, args }) => window.__spr[method](...args), {
			method,
			args,
		})
		.catch((error) => `the document went (${error.message.split('\n')[0]})`);
const read = (frame, expression) =>
	frame.evaluate(expression).catch(() => null);

/**
 * Click `selector` in `frame`, and once more when its document saw no
 * mousedown (an out-of-process frame's new place may not be hit-tested yet:
 * the site-pool suite's click)
 */
async function click(frame, selector) {
	for (let attempt = 0; attempt < 2; attempt++) {
		await frame.evaluate(() => {
			window.__sprPressed = false;
			addEventListener('mousedown', () => (window.__sprPressed = true), {
				capture: true,
				once: true,
			});
		});
		await frame.click(selector);
		for (let i = 0; i < 10; i++) {
			const pressed = await frame
				.evaluate(() => window.__sprPressed !== false)
				.catch(() => true); // the document went: it navigated
			if (pressed) return;
			await sleep(100);
		}
	}
}

/**
 * One mode's runs: `open(url)` shows the page of A at `url` as a top and
 * answers a function that answers its frame (a promise of it). Each run is a
 * page of A whose frame shows B
 */
async function runs(label, open) {
	const result = {};
	const landing = `${B}${PAGE}?role=landed`;
	/** a page of A and the frame of B in it (`query`: the frame's) */
	const shown = async (key, query = '') => {
		const element = await open(`${A}${PAGE}?${key}`);
		const top = await documentOf(element, 'top');
		if (!top) return null;
		const held = await call(top, 'hold');
		const url = `${B}${PAGE}?role=child&${key}${query}`;
		await call(top, 'show', url);
		const child = await documentOf(await top.$('#child'), 'child');
		return child && { element, top, child, held };
	};
	// the page's post to the frame's window it held, its read of the frame,
	// the frame's read of its parent and its post there, the page's
	// navigation of the window it held
	const first = await shown('posts');
	if (!first) {
		ok(`${label}: the page and its frame of the other site show`, false);
		return result;
	}
	result.where = [first.top, first.child].map(
		(frame) => new URL(frame.url()).origin,
	);
	result.held = first.held;
	result.postHeld = await call(first.top, 'postHeld', 'spr-held');
	result.readFrame = await call(first.top, 'readFrame');
	result.readParent = await call(first.child, 'readParent');
	result.postParent = await call(first.child, 'postParent', 'spr-parent');
	await sleep(1500);
	result.childMessages =
		(await read(first.child, () => window.__spr.messages)) ?? [];
	result.topMessages =
		(await read(first.top, () => window.__spr.messages)) ?? [];
	result.childRaw = (await read(first.child, () => window.__sprRaw)) ?? [];
	result.topRaw = (await read(first.top, () => window.__sprRaw)) ?? [];
	result.navigateHeld = await call(
		first.top,
		'navigateHeld',
		`${B}${PAGE}?role=child&navigated`,
	);
	const navigated = await documentOf(
		await first.top.$('#child'),
		'child',
		(search) => search.includes('navigated'),
		6000,
	);
	result.navigated = !!navigated;
	result.childStayed =
		(await read(first.child, () => window.__spr?.search)) ?? null;
	// a sandboxed frame of the page's site (DocumentClient.mayNavigate) holds
	// its own frame and navigates it once it shows the other site: a
	// descendant, which it may navigate
	await call(first.top, 'sandbox', `${A}${PAGE}?role=sandboxed`);
	const sandboxed = await documentOf(
		await first.top.$('#sandboxed'),
		'sandboxed',
	);
	if (sandboxed) {
		result.sandboxedHeld = await call(sandboxed, 'hold');
		await call(sandboxed, 'show', `${B}${PAGE}?role=child&below`);
		const below = await documentOf(await sandboxed.$('#child'), 'child');
		result.sandboxedNavigate = below
			? await call(
					sandboxed,
					'navigateHeld',
					`${B}${PAGE}?role=child&sandboxed-navigated`,
				)
			: 'its frame did not show';
		result.sandboxedNavigated = !!(await documentOf(
			await sandboxed.$('#child'),
			'child',
			(search) => search.includes('sandboxed-navigated'),
			6000,
		));
		result.sandboxedWhere = below && new URL(below.url()).origin;
	} else result.sandboxedNavigate = 'the sandboxed frame did not show';
	// the frame's link, form and submit() aimed at the top
	for (const way of ['link', 'form', 'submit']) {
		const run = await shown(
			way,
			`&to=${encodeURIComponent(`${landing}&by=${way}`)}`,
		);
		if (!run) {
			result[way] = 'not shown';
			continue;
		}
		if (way === 'link') await click(run.child, '#aimed');
		else if (way === 'form') await click(run.child, '#send');
		else result.submitCall = await call(run.child, 'submit');
		const landed = await documentOf(
			run.element,
			'landed',
			(search) => search.includes(`by=${way}`),
			6000,
		);
		result[way] = landed
			? 'top landed'
			: `top stayed ${(await read(run.top, () => window.__spr?.role)) ?? 'gone'}, frame ${(await read(run.child, () => window.__spr?.role)) ?? 'gone'}`;
	}
	return result;
}

// --- natively: the page of A as the tab's top ---
const native = await context.newPage();
const nativeRuns = await runs('natively', async (url) => {
	await native.goto(url);
	return async () => native.mainFrame();
});
await native.close();
console.log('natively:', JSON.stringify(nativeRuns));
ok(
	'natively, the posts arrive from the other site, the reads and the navigation go through, and the link, the form and submit() land in the top',
	nativeRuns.postHeld === 'posted' &&
		nativeRuns.postParent === 'posted' &&
		nativeRuns.childMessages.some(
			(m) => m.key === 'spr-held' && m.origin === new URL(A).origin,
		) &&
		nativeRuns.topMessages.some(
			(m) => m.key === 'spr-parent' && m.origin === new URL(B).origin,
		) &&
		!nativeRuns.readFrame.startsWith('threw') &&
		!nativeRuns.readParent.startsWith('threw') &&
		nativeRuns.navigateHeld === 'navigated' &&
		nativeRuns.navigated &&
		nativeRuns.link === 'top landed' &&
		nativeRuns.form === 'top landed' &&
		nativeRuns.submit === 'top landed' &&
		nativeRuns.submitCall === 'submitted' &&
		nativeRuns.sandboxedNavigate === 'navigated' &&
		nativeRuns.sandboxedNavigated,
	JSON.stringify(nativeRuns),
);

// --- proxied: the demo's page with controllers of the suite's own ---
await page.goto(`${PROXY}?nopool`);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
await page.evaluate(
	async ({ rewriter, good, broken }) => {
		document.getElementById('landing')?.style.setProperty('display', 'none');
		const { StompController } = await import('/stomp/controller.mjs');
		const make = async (origins) => {
			const controller = new StompController({
				serviceworker: window.controller.serviceworker,
				transport: window.controller.transport,
				directory: '/stomp/',
				codec: 'xor',
				...rewriter,
				sitePool: { origins },
			});
			await controller.wait();
			return controller;
		};
		window.made = { with: await make(good), without: await make(broken) };
		window.show = async (name, url) => {
			for (const old of document.querySelectorAll('.case')) old.remove();
			const element = document.createElement('iframe');
			element.className = 'case';
			element.style.cssText = 'width: 500px; height: 300px';
			document.body.append(element);
			await window.made[name].createFrame(element).go(url);
			return element;
		};
	},
	{ rewriter: REWRITER, good, broken },
);
const open = (name) => async (url) => {
	const element = (
		await page.evaluateHandle(({ name, url }) => window.show(name, url), {
			name,
			url,
		})
	).asElement();
	return () => element.contentFrame();
};

for (const [name, slots] of [
	['with', good],
	['without', broken],
]) {
	const label = name === 'with' ? 'with the parts' : 'without the parts';
	const result = await runs(label, open(name));
	// the slots the first page and its frame were shown from
	const where = result.where;
	console.log(`${label}:`, JSON.stringify(result));
	ok(
		`${label}: the page and its frame of the other site are shown from two slots of the pool`,
		!!where &&
			slots.includes(where[0]) &&
			slots.includes(where[1]) &&
			where[0] !== where[1],
		JSON.stringify(where),
	);
	if (name === 'with') {
		ok(
			`${label}: the page holds the frame's window while it is on about:blank, as natively`,
			result.held === nativeRuns.held,
			`${result.held} (natively ${nativeRuns.held})`,
		);
		for (const key of ['postHeld', 'postParent', 'readFrame', 'readParent'])
			ok(
				`${label}: ${key} answers as natively`,
				result[key] === nativeRuns[key],
				`${result[key]} (natively ${nativeRuns[key]})`,
			);
		ok(
			`${label}: the page's post to the frame's window of another slot arrives from the page's origin, as natively`,
			result.childMessages.length === 1 &&
				result.childMessages[0].key === 'spr-held' &&
				result.childMessages[0].origin === new URL(A).origin,
			JSON.stringify(result.childMessages),
		);
		ok(
			`${label}: the frame's post to its parent of another slot arrives from the frame's origin, as natively`,
			result.topMessages.length === 1 &&
				result.topMessages[0].key === 'spr-parent' &&
				result.topMessages[0].origin === new URL(B).origin,
			JSON.stringify(result.topMessages),
		);
		ok(
			`${label}: the browser dispatches each post to its receiver, once (the count without the parts is not vacuous)`,
			result.childRaw.length === 1 &&
				result.childRaw[0].includes('spr-held') &&
				result.topRaw.length === 1 &&
				result.topRaw[0].includes('spr-parent'),
			JSON.stringify([result.childRaw, result.topRaw]),
		);
		ok(
			`${label}: the page's navigation of the frame's window of another slot lands, as natively`,
			result.navigateHeld === nativeRuns.navigateHeld && result.navigated,
			`${result.navigateHeld} landed: ${result.navigated}`,
		);
		for (const way of ['link', 'form', 'submit'])
			ok(
				`${label}: the frame's ${way === 'submit' ? 'submit()' : way} aimed at its top of another slot lands there, as natively`,
				result[way] === nativeRuns[way] &&
					(way !== 'submit' || result.submitCall === nativeRuns.submitCall),
				`${result[way]} ${way === 'submit' ? result.submitCall : ''} (natively ${nativeRuns[way]})`,
			);
		ok(
			`${label}: a sandboxed frame's navigation of its own frame of another slot lands, as natively`,
			result.sandboxedWhere === result.where?.[1] &&
				result.sandboxedHeld === nativeRuns.sandboxedHeld &&
				result.sandboxedNavigate === nativeRuns.sandboxedNavigate &&
				result.sandboxedNavigated,
			`${result.sandboxedNavigate} landed: ${result.sandboxedNavigated} from ${result.sandboxedWhere} (natively ${nativeRuns.sandboxedNavigate})`,
		);
	} else {
		ok(
			"without the parts: every slot's library file had a parts statement, replaced",
			fronted.length > 0 && fronted.every(Boolean),
			JSON.stringify(fronted),
		);
		ok(
			`${label}: the page holds the frame's window while it is on about:blank, as natively`,
			result.held === nativeRuns.held,
			`${result.held} (natively ${nativeRuns.held})`,
		);
		for (const key of ['postHeld', 'postParent', 'readFrame', 'readParent'])
			ok(
				`${label}: ${key} throws`,
				typeof result[key] === 'string' && result[key].startsWith('threw '),
				result[key],
			);
		ok(
			`${label}: nothing is posted, the browser's own postMessage included`,
			result.childMessages.length === 0 &&
				result.topMessages.length === 0 &&
				result.childRaw.length === 0 &&
				result.topRaw.length === 0,
			JSON.stringify([
				result.childMessages,
				result.topMessages,
				result.childRaw,
				result.topRaw,
			]),
		);
		ok(
			`${label}: the page's navigation of the frame's window of another slot throws and navigates nothing`,
			typeof result.navigateHeld === 'string' &&
				result.navigateHeld.startsWith('threw ') &&
				!result.navigated &&
				typeof result.childStayed === 'string' &&
				result.childStayed.includes('posts'),
			`${result.navigateHeld} landed: ${result.navigated}, the frame: ${result.childStayed}`,
		);
		for (const way of ['link', 'form', 'submit'])
			ok(
				`${label}: the frame's ${way === 'submit' ? 'submit()' : way} aimed at its top of another slot navigates nothing${way === 'submit' ? ' and throws' : ''}`,
				result[way] === 'top stayed top, frame child' &&
					(way !== 'submit' ||
						(typeof result.submitCall === 'string' &&
							result.submitCall.startsWith('threw '))),
				`${result[way]} ${way === 'submit' ? result.submitCall : ''}`,
			);
		ok(
			`${label}: a sandboxed frame's navigation of its own frame of another slot throws and navigates nothing`,
			result.sandboxedWhere === result.where?.[1] &&
				result.sandboxedHeld === nativeRuns.sandboxedHeld &&
				typeof result.sandboxedNavigate === 'string' &&
				result.sandboxedNavigate.startsWith('threw ') &&
				!result.sandboxedNavigated,
			`${result.sandboxedNavigate} landed: ${result.sandboxedNavigated} from ${result.sandboxedWhere}`,
		);
	}
}

await done(browser, errors);
