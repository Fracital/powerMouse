// The site pool's shared rewriter library (src/controller/slotLibrary.ts):
// a slot's agent makes one library, in a realm of its own document no page
// code runs in, for every frame of its slot that has no proxied top in
// reach (a frame of another slot than its page's). Sites that share a slot
// share it: a page of 127.0.0.1 with frames of localhost and 127.0.0.2, a
// pool of two slots, shows the page from one slot and both frames from the
// other, both rewriting in that slot's agent's library. With a pool of one
// slot every site is in it, and the frames rewrite in their top's library,
// as without a pool. Checked, in both pools:
// - the two frames of the shared slot rewrite in the agent's library (else
//   the rest checks nothing);
// - no document of any of the three sites reaches the agent's window, its
//   share or the library's realm (the same walk from the raw top finds
//   the share): walks by `top`, `parent`, `opener`, `frames` and the window's
//   indices from the window, from the browser's own getters, from
//   `window.open('', target)`, from a popup it opened on about:blank
//   (through that popup's own globals) and from every `event.source` it
//   heard, the page knowing the share's name, and no key of its own window
//   names the client or the share;
// - the page and both frames seal a URL to the same text, whether in a
//   codec module's instance (the page's, and a frame of its slot in it) or
//   in JavaScript (a frame of another slot, src/wasm/codec.ts);
// - a page that replaces methods of its own realm's Array, Object, String,
//   RegExp and JSON, and then has its rewrites made, changes nothing of how
//   another site's frame in the same slot is rewritten: that frame's eval,
//   new Function and indirect eval answer as before and as natively.
import { done, FIXTURE, launch, ok, PROXY, REWRITER, sleep } from '../lib.mjs';

const A = FIXTURE;
const B = FIXTURE.replace('127.0.0.1', 'localhost');
const C = FIXTURE.replace('127.0.0.1', '127.0.0.2');
const PAGE = 'pages/site-pool.html';
const run = Date.now().toString(36);

// 127.0.0.2 as well: the third site, which Chrome reaches natively
const browser = await launch([
	'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1, EXCLUDE 127.0.0.2',
]);
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];

const asPage = (frame, code) =>
	frame.evaluate((code) => Function(code)(), code);

/** the frame of an element handle, once it shows a document whose URL passes `test` */
async function frameOf(element, test = () => true, ms = 45000) {
	const until = Date.now() + ms;
	for (;;) {
		const frame = await element.contentFrame();
		if (frame && test(frame.url())) {
			try {
				await frame.waitForLoadState('load', { timeout: 5000 });
			} catch (error) {
				// loaded by the time its URL shows
			}
			return frame;
		}
		if (Date.now() > until) return frame;
		await sleep(100);
	}
}

/** the child frames of `parent` whose real location starts with `site` */
async function childOn(parent, site, ms = 45000) {
	const until = Date.now() + ms;
	for (;;) {
		for (const child of parent.childFrames()) {
			const href = await asPage(child, 'return location.href').catch(
				() => null,
			);
			if (typeof href === 'string' && href.startsWith(site)) {
				await child
					.waitForFunction(() => document.readyState === 'complete', null, {
						timeout: 10000,
					})
					.catch(() => {});
				return child;
			}
		}
		if (Date.now() > until) return null;
		await sleep(200);
	}
}

/** add a frame of `url` to `frame`'s document */
const addFrame = (frame, url) =>
	asPage(
		frame,
		`const f = document.createElement('iframe'); f.src = ${JSON.stringify(url)}; document.body.append(f);`,
	);

/**
 * What a document's eval, new Function and indirect eval answer, each made
 * anew (`nonce` keeps them out of every cache): the rewriter's work, which a
 * poisoned library would change
 */
const PROBE = (nonce) => `
	const n = ${JSON.stringify(nonce)};
	const answers = [];
	const tryIt = (code) => {
		try {
			answers.push(String(eval(code + ' /*' + n + '*/')));
		} catch (error) {
			answers.push('threw ' + error.name);
		}
	};
	tryIt('location.href');
	tryIt('typeof top.location');
	tryIt('(() => { try { return top.location.href } catch (e) { return e.name } })()');
	tryIt('[1, 2, 3].map((x) => x * 2).join("-")');
	tryIt('JSON.stringify({ a: [1, "b"], c: /x+/.source })');
	tryIt('"a-b-c".replace(/-/g, "+").slice(1)');
	tryIt('Object.keys({ x: 1, y: 2 }).length');
	answers.push(String(new Function('return location.origin /*' + n + '*/')()));
	answers.push(String((0, eval)('document.domain /*' + n + '*/')));
	answers.push(String((0, eval)('window.location.pathname /*' + n + '*/')));
	return JSON.stringify(answers);
`;

/**
 * The page's own realm's builtins replaced with what answers nonsense, each
 * on its own and then all of them, each time with rewrites asked of the
 * library (an eval, a new Function): how many of those calls ran. The
 * replacements stay
 */
const POLLUTE = `
	const bad = () => 'POLLUTED';
	const replaced = [
		[Array.prototype, 'join', bad],
		[Array.prototype, 'map', function () { return ['POLLUTED']; }],
		[Array.prototype, 'push', function () { return 0; }],
		[Array.prototype, 'indexOf', () => -1],
		[Array.prototype, 'slice', function () { return ['POLLUTED']; }],
		[Object, 'keys', () => ['POLLUTED']],
		[Object, 'assign', (target) => target],
		[Object, 'entries', () => []],
		[Object.prototype, 'toString', bad],
		[String.prototype, 'replace', bad],
		[String.prototype, 'slice', bad],
		[String.prototype, 'indexOf', () => -1],
		[String.prototype, 'split', () => ['POLLUTED']],
		[String.prototype, 'toString', bad],
		[String.prototype, 'charCodeAt', () => 0],
		[RegExp.prototype, 'exec', () => null],
		[RegExp.prototype, 'test', () => false],
		[RegExp.prototype, Symbol.replace, bad],
		[JSON, 'stringify', bad],
		[JSON, 'parse', () => ({ polluted: true })],
	];
	let ran = 0;
	let n = 0;
	const rewrites = () => {
		for (const code of ['1 + 1', 'location.href', '[1].map(String)', 'JSON.stringify({ a: 1 })', '"a-b".replace(/-/, "+")'])
			try { eval(code + ' /*${run}-polluted-' + n++ + '*/'); ran++; } catch (error) {}
		try { new Function('return location.href /*${run}-pf-' + n++ + '*/')(); ran++; } catch (error) {}
	};
	for (const [object, name, value] of replaced) {
		const kept = object[name];
		object[name] = value;
		rewrites();
		object[name] = kept;
	}
	for (const [object, name, value] of replaced) object[name] = value;
	rewrites();
	return ran;
`;

/**
 * Every window a document reaches from `seeds`, by `top`, `parent`,
 * `opener`, `frames` and indices, and which of them is an agent (its path
 * is controllerFrame.html) or holds the share `key`
 */
const REACH = (key, seeds) => `
	const key = ${JSON.stringify(key)};
	const seen = new Set();
	const queue = [];
	const add = (w, path) => {
		try {
			if (w && (typeof w === 'object' || typeof w === 'function') && !seen.has(w)) {
				seen.add(w);
				queue.push([w, path]);
			}
		} catch (error) {}
	};
	${seeds}
	const hits = [];
	for (let i = 0; i < queue.length && i < 400; i++) {
		const [w, path] = queue[i];
		try {
			if (Object.getOwnPropertyDescriptor(w, key)) hits.push(path + ' holds the share');
		} catch (error) {}
		try {
			if (key in w) hits.push(path + ' has the share');
		} catch (error) {}
		try {
			if (String(w.location.pathname).endsWith('controllerFrame.html'))
				hits.push(path + ' is an agent');
		} catch (error) {}
		for (const p of ['parent', 'top', 'opener', 'frames', 'self', 'window'])
			try { add(w[p], path + '.' + p); } catch (error) {}
		let n = 0;
		try { n = Number(w.length) || 0; } catch (error) {}
		for (let j = 0; j < n && j < 24; j++) {
			try { add(w[j], path + '[' + j + ']'); } catch (error) {}
			try { add(w.frames[j], path + '.frames[' + j + ']'); } catch (error) {}
		}
	}
	return JSON.stringify({ windows: seen.size, hits });
`;

/** the seeds of a walk from the document's own window, its getters and its stand-ins */
const OWN_SEEDS = `
	add(window, 'window');
	for (const p of ['top', 'parent', 'opener', 'frames', 'self'])
		try { add(window[p], p); } catch (error) {}
	for (const p of ['top', 'parent', 'opener', 'frames'])
		try {
			const getter = Object.getOwnPropertyDescriptor(window, p)?.get;
			if (getter) add(getter.call(window), 'getter ' + p);
		} catch (error) {}
	try { add(Reflect.getPrototypeOf(window), 'prototype'); } catch (error) {}
	for (const w of window.__heard || []) add(w, 'event.source');
`;
/** the seeds from window.open('', target), which opens nothing for a window that exists */
const OPEN_SEEDS = `
	for (const target of ['_self', '_parent', '_top'])
		try { add(window.open('', target), 'open ' + target); } catch (error) {}
`;

// --- natively: the page of A with frames of B and C ---
const native = await context.newPage();
await native.goto(`${A}${PAGE}?${run}-native`);
await addFrame(native.mainFrame(), `${B}${PAGE}?${run}-nb`);
await addFrame(native.mainFrame(), `${C}${PAGE}?${run}-nc`);
const nativeC = await childOn(native.mainFrame(), C);
const nativeProbe = nativeC
	? JSON.parse(await asPage(nativeC, PROBE('native')))
	: null;
ok(
	'natively, the frame of 127.0.0.2 answers the probe',
	Array.isArray(nativeProbe),
	JSON.stringify(nativeProbe),
);
await native.close();

// --- proxied ---
await page.goto(`${PROXY}?nopool`);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const ports = await page.evaluate(() => window.STOMP_CONFIG.sitePool);
ok(
	'the demo server answers on three pool ports',
	Array.isArray(ports) && ports.length >= 3,
	JSON.stringify(ports),
);
const SLOTS = ports.map((port) => `http://127.0.0.1:${port}`);
const slotOf = (url) => {
	try {
		return new URL(url).origin;
	} catch (error) {
		return null;
	}
};
await page.evaluate(
	async ({ rewriter, SLOTS }) => {
		document.getElementById('landing')?.style.setProperty('display', 'none');
		const { StompController } = await import('/stomp/controller.mjs');
		const make = (extra) =>
			new StompController({
				serviceworker: window.controller.serviceworker,
				transport: window.controller.transport,
				directory: '/stomp/',
				codec: 'xor',
				...rewriter,
				...extra,
			});
		window.two = make({ sitePool: { origins: SLOTS.slice(0, 2) } });
		window.one = make({ sitePool: { origins: [SLOTS[2]] } });
		await Promise.all([window.two.wait(), window.one.wait()]);
		window.show = async (controller, url) => {
			const element = document.createElement('iframe');
			element.style.cssText = 'width: 600px; height: 300px';
			document.body.append(element);
			await controller.createFrame(element).go(url);
			return element;
		};
	},
	{ rewriter: REWRITER, SLOTS },
);

for (const [mode, pool, frameSlots] of [
	['a pool of two', 'two', SLOTS.slice(0, 2)],
	['a pool of one', 'one', [SLOTS[2]]],
]) {
	// each controller mints its own client name, which the share's is made of
	const clientName = await page.evaluate(
		(pool) => window[pool].config.names.client,
		pool,
	);
	const key = `${clientName}$slot`;
	const element = (
		await page.evaluateHandle(
			({ pool, url }) => window.show(window[pool], url),
			{ pool, url: `${A}${PAGE}?${run}-${pool}` },
		)
	).asElement();
	const top = await frameOf(element, (url) => frameSlots.includes(slotOf(url)));
	await addFrame(top, `${B}${PAGE}?${run}-${pool}-b`);
	await addFrame(top, `${C}${PAGE}?${run}-${pool}-c`);
	const b = await childOn(top, B);
	const c = await childOn(top, C);
	ok(
		`${mode}: the page shows both frames`,
		b !== null && c !== null,
		`${b?.url()} ${c?.url()}`,
	);
	if (!b || !c) continue;
	const slots = [top, b, c].map((frame) => slotOf(frame.url()));
	if (pool === 'two')
		ok(
			`${mode}: the page is in one slot and both frames share the other`,
			slots[0] !== slots[1] && slots[1] === slots[2],
			slots.join(' '),
		);
	else
		ok(
			`${mode}: the page and both frames share the slot`,
			slots.every((slot) => slot === slots[0]),
			slots.join(' '),
		);

	// what each frame rewrites in, as the agent of the frames' slot sees it
	const agent = page
		.frames()
		.find(
			(frame) =>
				slotOf(frame.url()) === slots[1] &&
				frame.url().includes('/controllerFrame.html'),
		);
	const sharing = await agent?.evaluate(
		({ name, key }) => {
			const share = Object.getOwnPropertyDescriptor(window, key)?.value;
			const libraries = [];
			for (let i = 0; i < parent.length; i++)
				for (let j = 0; j < parent[i].length; j++)
					try {
						const client = parent[i][j][name];
						if (client)
							libraries.push(
								client.sharedRewriter === null
									? 'top'
									: client.sharedRewriter === share?.rewriter
										? 'agent'
										: 'own',
							);
					} catch (error) {
						// another origin's
					}
			return libraries;
		},
		{ name: clientName, key },
	);
	if (pool === 'two')
		ok(
			`${mode}: both frames of the shared slot rewrite in its agent's library`,
			sharing?.length === 2 && sharing.every((kind) => kind === 'agent'),
			JSON.stringify(sharing ?? 'no agent'),
		);
	else
		ok(
			`${mode}: both frames rewrite in their top's library, as without a pool`,
			sharing?.length >= 2 && sharing.every((kind) => kind === 'top'),
			JSON.stringify(sharing ?? 'no agent'),
		);

	// where each document seals (src/wasm/codec.ts codecRuns): a frame of
	// another slot holds no parts of its own top's shell, so it seals in
	// JavaScript, with no request, and must write what its top's module
	// writes; one of its top's slot seals in its top's instance
	const SEALED = `https://example.com/${'path/'.repeat(40)}?q=${'\u00e9\u4e2d'.repeat(30)}#x`;
	const seals = await Promise.all(
		[top, b, c].map((frame) =>
			frame
				.evaluate(
					({ name, text }) => {
						const client = window[name];
						const sealed = client.codec.encode(text);
						return {
							runs: client.codecRuns,
							sealed,
							opened: client.codec.decode(sealed) === text,
						};
					},
					{ name: clientName, text: SEALED },
				)
				.catch((error) => ({ error: error.message })),
		),
	);
	ok(
		`${mode}: the page and both frames seal a URL to the same text and open it again`,
		seals.every(
			(seal) => seal.opened === true && seal.sealed === seals[0].sealed,
		),
		JSON.stringify(
			seals.map(({ runs, opened, error, sealed }) => ({
				runs,
				opened,
				error,
				same: sealed === seals[0].sealed,
			})),
		),
	);

	// the walk finds the agent where the hub's page is in reach: from the
	// browser's own top of a window of the slot's origin no hook holds back
	// (the agent's own)
	const fromTop = agent
		? JSON.parse(
				await agent.evaluate(
					(code) => Function(code)(),
					REACH(key, "add(top, 'top');"),
				),
			)
		: null;
	ok(
		`${mode}: the walk finds the agent's share from the raw top`,
		fromTop?.hits.some((hit) => hit.endsWith('holds the share')),
		JSON.stringify(fromTop),
	);

	// messages to the frames, for the walks from event.source
	for (const frame of [b, c])
		await asPage(
			frame,
			`window.__heard = []; addEventListener('message', (event) => { try { window.__heard.push(event.source); } catch (error) {} });`,
		);
	await asPage(
		top,
		'for (let i = 0; i < frames.length; i++) frames[i].postMessage("from the page", "*");',
	);
	await asPage(
		b,
		'for (let i = 0; i < parent.frames.length; i++) parent.frames[i].postMessage("from b", "*"); parent.postMessage("from b", "*");',
	);
	await asPage(c, 'postMessage("from c", "*");');
	await sleep(500);

	for (const [name, frame] of [
		['the page', top],
		['the frame of localhost', b],
		['the frame of 127.0.0.2', c],
	]) {
		const walked = JSON.parse(
			await asPage(frame, REACH(key, OWN_SEEDS + OPEN_SEEDS)),
		);
		ok(
			`${mode}: ${name} reaches no agent, share or library realm by top, parent, opener, frames, event.source or window.open('', target)`,
			walked.hits.length === 0 && walked.windows > 1,
			JSON.stringify(walked),
		);
		// a popup on about:blank, walked with its own globals
		const popup = await asPage(
			frame,
			`const w = window.open('about:blank', ${JSON.stringify(`${run}-${pool}-popup`)});
			if (!w) return JSON.stringify({ opened: false });
			let answer;
			try {
				answer = w.Function(${JSON.stringify(REACH(key, "add(window, 'popup'); try { add(opener, 'popup.opener'); } catch (error) {}"))})();
			} catch (error) {
				answer = JSON.stringify({ threw: error.name, hits: [] });
			}
			try { w.close(); } catch (error) {}
			return answer;`,
		);
		const fromPopup = JSON.parse(popup);
		ok(
			`${mode}: ${name}'s popup on about:blank reaches no agent, share or library realm through its own globals`,
			fromPopup.opened !== false && fromPopup.hits.length === 0,
			popup,
		);
		const keys = await asPage(
			frame,
			`return JSON.stringify(Reflect.ownKeys(window).filter((k) => typeof k === 'string' && (k.endsWith('$slot') || k === ${JSON.stringify(clientName)})));`,
		);
		ok(
			`${mode}: ${name} sees no key of the client or the share on its window`,
			keys === '[]',
			keys,
		);
	}

	// the frame of 127.0.0.2 before and after the frame of localhost, which
	// rewrites in the same library, polluted its own realm
	const before = JSON.parse(await asPage(c, PROBE(`${run}-${pool}-before`)));
	// (the harness's own serializer may trip on the polluted realm: the
	// pollution is done by then)
	const made = await asPage(b, POLLUTE).catch(
		(error) => `the evaluate threw ${error.message.slice(0, 80)}`,
	);
	const after = JSON.parse(await asPage(c, PROBE(`${run}-${pool}-after`)));
	// the answers that name the page's own URL are the frame's: natively's
	// with the native run's query
	const same = (answers) =>
		JSON.stringify(answers?.map((answer) => answer.replace(/\?[\w-]+/, '?q')));
	ok(
		`${mode}: the frame of 127.0.0.2 answers the probe as natively`,
		same(before) === same(nativeProbe),
		`${JSON.stringify(before)} natively ${JSON.stringify(nativeProbe)}`,
	);
	ok(
		`${mode}: a frame of another site in the slot that pollutes its own realm's builtins changes nothing of its rewrites`,
		made !== 0 && JSON.stringify(after) === JSON.stringify(before),
		`${made} rewrites in a polluted realm; ${JSON.stringify(after)} before ${JSON.stringify(before)}`,
	);
}

await done(browser, errors);
