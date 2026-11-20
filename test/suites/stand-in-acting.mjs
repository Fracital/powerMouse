// What a sandboxed document does through the windows it holds of other
// origins, against Chrome: its navigation of its top and of another frame,
// its messages (who the receiver hears them from, and their origin), its
// popups and its storage. Every document of an origin shares one stand-in
// for a window of another origin (identity: `top` and `parent.top` are one
// object), so the stand-in must act for the document whose code calls it,
// never for the one that read it last: a sandboxed frame's same-origin
// parent reading `top` (its own code, or the demo host walking the frames'
// parents) had the frame's `top.location.href = url` made as the parent's
// navigation, past the frame's sandbox. Most scenarios have the parent set
// document.domain first, so the frame (sandboxed, it cannot set one) no
// longer reaches its parent: natively it cannot act through its parent's
// realm either. Served by test/private-sites.mjs at /ps/si
// (test/pages/stand-in.html), under co.uk: another site (stomp-b) is the
// top, the frames are of www.stomp-a and two.stomp-a. Every scenario in a
// tab of its own; natively, then through the demo in both modes.
import {
	done,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';
import { startPrivateSites } from '../private-sites.mjs';

const sites = await startPrivateSites();
const HOSTS = {
	sub: 'www.stomp-a.co.uk',
	two: 'two.stomp-a.co.uk',
	b: 'stomp-b.co.uk',
};
const SITE = 'stomp-a.co.uk';
const SANDBOX = 'allow-scripts allow-same-origin';
let serial = 0;

/** the page on `host` as `id`, with Origin-Agent-Cluster: ?`oac` when given */
const pageURL = (host, id, oac) =>
	`${sites.origin(HOSTS[host])}/ps/si?id=${id}${oac === undefined ? '' : `&oac=${oac}`}`;

/**
 * A driver over a tab: `frameOf(id)` finds the document of that id in any
 * page of the context, `call(id, method, ...args)` runs one of its page's
 * functions (page code, rewritten through the proxy), `exists(id)` whether
 * a document of that id came
 */
function driver(context) {
	const frameOf = async (id, tries = 80) => {
		for (let i = 0; i < tries; i++) {
			for (const page of context.pages())
				for (const frame of page.frames()) {
					const found = await frame
						.evaluate(() => window.__si?.id ?? null)
						.catch(() => null);
					if (found === id) return frame;
				}
			await sleep(150);
		}
		throw new Error(`no document ${id}`);
	};
	const call = async (id, method, ...args) =>
		(await frameOf(id)).evaluate(
			([method, args]) => window.__si[method](...args),
			[method, args],
		);
	const exists = async (id) =>
		frameOf(id, 12).then(
			() => true,
			() => false,
		);
	return { call, exists };
}

/**
 * A top of another site, a frame of www.stomp-a in it (`p`) that reads
 * `top`, then (`domain`) sets document.domain to the site, and a frame of
 * the same origin in that one (`f`, under `sandbox`), which reads `top`
 * too. `f` no longer reaches `p` when `p` set the domain: what each reaches
 * of the other is read first
 */
async function nested(go, call, id, { domain = true, sandbox = SANDBOX } = {}) {
	await go(pageURL('b', id('top')));
	await call(id('top'), 'frame', pageURL('sub', id('p'), 0), null);
	const setup = { parentTop: await call(id('p'), 'touch', 'top') };
	if (domain) setup.parentSet = await call(id('p'), 'setDomain', SITE);
	await call(id('p'), 'frame', pageURL('sub', id('f'), 0), sandbox);
	setup.frameSet = await call(id('f'), 'setDomain', SITE);
	setup.frameReachesParent = await call(id('f'), 'reach', 'parent');
	setup.frameTop = await call(id('f'), 'keep', 'top');
	return setup;
}

/** whether a document of `id` arrived, after a moment for it to */
const arrived = async (exists, id) => {
	await sleep(1200);
	return exists(id);
};

/** each scenario: open its top with `visit`, then what it does */
const SCENARIOS = {};

// the frame navigates its top (to a page of the top's own origin, which
// Chrome's framebusting intervention lets an unsandboxed frame of another
// origin do) after its parent read `top` last
for (const form of ['href', 'location', 'replace', 'reflect'])
	SCENARIOS[
		`the parent set document.domain: the sandboxed frame navigates its top (${form})`
	] = async (go, call, id, walk, exists) => {
		const setup = await nested(go, call, id);
		await call(id('p'), 'touch', 'top');
		const navigated = await call(
			id('f'),
			'navigate',
			'kept',
			pageURL('b', id('landed')),
			form,
		);
		return { setup, navigated, landed: await arrived(exists, id('landed')) };
	};
SCENARIOS[
	'the parent set document.domain: the sandboxed frame navigates its top after the outermost page walked the parents'
] = async (go, call, id, walk, exists) => {
	const setup = await nested(go, call, id);
	await walk();
	const navigated = await call(
		id('f'),
		'navigate',
		'kept',
		pageURL('b', id('landed')),
		'href',
	);
	return { setup, navigated, landed: await arrived(exists, id('landed')) };
};
// the frame reaches its parent here, and the parent's `parent` getter,
// which the frame's own code runs, made the parent the last to read it
SCENARIOS[
	'same origin: the sandboxed frame navigates its top after reading parent.parent'
] = async (go, call, id, walk, exists) => {
	const setup = await nested(go, call, id, { domain: false });
	setup.parentTop = await call(id('f'), 'touch', 'parent.parent');
	const navigated = await call(
		id('f'),
		'navigate',
		'kept',
		pageURL('b', id('landed')),
		'href',
	);
	return { setup, navigated, landed: await arrived(exists, id('landed')) };
};
SCENARIOS[
	'an opaque sandboxed frame navigates its top after its parent read it'
] = async (go, call, id, walk, exists) => {
	const setup = await nested(go, call, id, {
		domain: false,
		sandbox: 'allow-scripts',
	});
	await call(id('p'), 'touch', 'top');
	const navigated = await call(
		id('f'),
		'navigate',
		'kept',
		pageURL('b', id('landed')),
		'href',
	);
	return { setup, navigated, landed: await arrived(exists, id('landed')) };
};

// who the top hears the frame's messages from, each way a page posts one
const posts = (parentReads) => async (go, call, id) => {
	const setup = await nested(go, call, id, { domain: parentReads !== 'same' });
	if (parentReads === 'same')
		setup.parentTop = await call(id('f'), 'touch', 'parent.parent');
	else await call(id('p'), 'touch', 'top');
	const sent = [];
	for (const form of ['plain', 'call', 'apply', 'kept', 'reflect'])
		sent.push(await call(id('f'), 'post', 'kept', form));
	await sleep(500);
	return { setup, sent, heard: await call(id('top'), 'heard') };
};
SCENARIOS[
	'the parent set document.domain: the sandboxed frame posts to its top'
] = posts('domain');
SCENARIOS[
	'same origin: the sandboxed frame posts to its top after reading parent.parent'
] = posts('same');
SCENARIOS[
	'an opaque sandboxed frame posts to its top after its parent read it'
] = async (go, call, id) => {
	const setup = await nested(go, call, id, {
		domain: false,
		sandbox: 'allow-scripts',
	});
	await call(id('p'), 'touch', 'top');
	const sent = [];
	for (const form of ['plain', 'call', 'apply', 'reflect'])
		sent.push(await call(id('f'), 'post', 'kept', form));
	await sleep(500);
	return { setup, sent, heard: await call(id('top'), 'heard') };
};

// a frame of another origin of the site beside the parent (`q`), which
// the parent reaches once both set the domain: the sandboxed frame reaches
// it no more than natively, and may not navigate it
const sibling = (sandbox, act) => async (go, call, id, walk, exists) => {
	await go(pageURL('b', id('top')));
	await call(id('top'), 'frame', pageURL('sub', id('p'), 0), null);
	await call(id('top'), 'frame', pageURL('two', id('q'), 0), null, 'q');
	const setup = {
		parentTop: await call(id('p'), 'touch', 'top'),
		parentSibling: await call(id('p'), 'touch', 'top[1]'),
		set: [
			await call(id('p'), 'setDomain', SITE),
			await call(id('q'), 'setDomain', SITE),
		],
		parentReaches: await call(id('p'), 'reach', 'top[1]'),
	};
	await call(id('p'), 'frame', pageURL('sub', id('f'), 0), sandbox);
	setup.frameTop = await call(id('f'), 'touch', 'top');
	setup.frameSibling = await call(id('f'), 'keep', 'top[1]');
	await call(id('p'), 'touch', 'top');
	await call(id('p'), 'touch', 'top[1]');
	return { setup, ...(await act(call, id, exists)) };
};
SCENARIOS[
	'the parent and a frame beside it set document.domain: the sandboxed frame reaches that frame'
] = sibling(SANDBOX, async (call, id) => ({
	reach: {
		index: await call(id('f'), 'reach', 'top[1]'),
		frames: await call(id('f'), 'reach', 'top.frames[1]'),
		named: await call(id('f'), 'reach', 'top.q'),
		parentOf: await call(id('f'), 'reach', 'top[0].parent'),
		reflectIndex: await call(id('f'), 'reach', 'Reflect.get(top, 1)'),
		reflectNamed: await call(id('f'), 'reach', "Reflect.get(top, 'q')"),
	},
}));
SCENARIOS[
	'the parent and a frame beside it set document.domain: an unsandboxed frame that did not reaches that frame'
] = sibling(null, async (call, id) => ({
	reach: {
		index: await call(id('f'), 'reach', 'top[1]'),
		frames: await call(id('f'), 'reach', 'top.frames[1]'),
		named: await call(id('f'), 'reach', 'top.q'),
	},
}));
SCENARIOS[
	'the parent and a frame beside it set document.domain: the sandboxed frame navigates that frame'
] = sibling(SANDBOX, async (call, id, exists) => ({
	navigated: await call(
		id('f'),
		'navigate',
		'kept',
		pageURL('two', id('landed'), 0),
		'href',
	),
	landed: await arrived(exists, id('landed')),
}));
SCENARIOS[
	'the parent and a frame beside it set document.domain: the sandboxed frame posts to that frame'
] = sibling(SANDBOX, async (call, id) => {
	const sent = [];
	for (const form of ['plain', 'call', 'apply', 'reflect'])
		sent.push(await call(id('f'), 'post', 'kept', form));
	await sleep(500);
	return { sent, heard: await call(id('q'), 'heard') };
});

// the record of who took a stand-in is written where no page sees it: a
// page that put setters on Object.prototype, then read windows of another
// origin (its frame too), saw nothing of the inject written there
SCENARIOS[
	'a page with setters on Object.prototype and its frame read windows of another origin'
] = async (go, call, id) => {
	await go(pageURL('b', id('top')));
	await call(id('top'), 'frame', pageURL('sub', id('p'), 0), null);
	const trap = await call(id('p'), 'trap');
	await call(id('p'), 'touch', 'top');
	await call(id('p'), 'touch', 'top[0]');
	await call(id('p'), 'frame', pageURL('sub', id('f'), 0), SANDBOX);
	await call(id('f'), 'trap');
	await call(id('f'), 'touch', 'top');
	await call(id('f'), 'touch', 'parent.parent');
	await call(id('p'), 'touch', 'top');
	await call(id('f'), 'post', 'top', 'plain');
	return {
		trap,
		parent: await call(id('p'), 'trapped'),
		frame: await call(id('f'), 'trapped'),
	};
};

// popups and storage: the frame's own, whatever its parent read
SCENARIOS['the parent set document.domain: the sandboxed frame opens a popup'] =
	async (go, call, id, walk, exists) => {
		const setup = await nested(go, call, id);
		await call(id('p'), 'touch', 'top');
		const opened = await call(id('f'), 'open', pageURL('b', id('popup')));
		return { setup, opened, came: await arrived(exists, id('popup')) };
	};
SCENARIOS['the parent set document.domain: the sandboxed frame reads storage'] =
	async (go, call, id) => {
		const setup = await nested(go, call, id);
		await call(id('p'), 'touch', 'top');
		return { setup, storage: await call(id('f'), 'storage') };
	};
SCENARIOS['an opaque sandboxed frame reads storage after its parent read top'] =
	async (go, call, id) => {
		const setup = await nested(go, call, id, {
			domain: false,
			sandbox: 'allow-scripts',
		});
		await call(id('p'), 'touch', 'top');
		return {
			setup,
			storage: await call(id('f'), 'storage'),
			opened: await call(id('f'), 'open', pageURL('b', id('popup'))),
		};
	};

/**
 * Every window's way up by `parent`, from each window below the outermost
 * page, read by that page's own code: the demo host's when proxied, as
 * agent-cluster's walk, natively the top's. The deepest windows climb
 * first, so the frame's parent is the last whose getters run: through the
 * proxy that made the parent the last to read the top
 */
function walkParents() {
	const down = (window, depth) => {
		if (depth < 4)
			for (let index = 0; index < window.length; index++)
				down(window[index], depth + 1);
		for (let up = window, steps = 0; steps < 16; steps++) {
			if (up === up.parent) break;
			up = up.parent;
		}
	};
	down(window, 0);
	return 'walked';
}

/** what every scenario did, run in `context` with `visit` loading a top */
async function runAll(context, visit, tag, outside) {
	const { call, exists } = driver(context);
	const out = {};
	for (const [name, scenario] of Object.entries(SCENARIOS)) {
		const n = ++serial;
		const id = (role) => `${tag}-${n}-${role}`;
		try {
			out[name] = await scenario(
				(url) => visit(url),
				call,
				id,
				async () => {
					if ((await outside().evaluate(walkParents)) !== 'walked')
						throw new Error('no walk');
				},
				exists,
			);
		} catch (error) {
			out[name] = { error: String(error).split('\n')[0] };
		}
	}
	return out;
}

const features = '--disable-features=PaintHolding';
const nativeBrowser = await launch([...sites.nativeArgs, features]);
const nativeContext = await nativeBrowser.newContext();
let current;
const native = await runAll(
	nativeContext,
	async (url) => {
		for (const page of nativeContext.pages()) await page.close();
		current = await nativeContext.newPage();
		await current.goto(url);
	},
	'native',
	() => current,
);
await nativeBrowser.close();
for (const [name, value] of Object.entries(native))
	ok(`natively: ${name}`, !value.error, JSON.stringify(value));

const browser = await launch([features]);
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const proxied = await runAll(
		page.context(),
		async (url) => {
			for (const other of page.context().pages())
				if (other !== page) await other.close();
			await page.click('#home').catch(() => {});
			await submitLanding(page, url);
		},
		mode,
		() => page,
	);
	for (const [name, value] of Object.entries(native)) {
		const a = JSON.stringify(value);
		const b = JSON.stringify(proxied[name] ?? null);
		ok(
			`${mode}: ${name} as natively`,
			a === b,
			`\n      native  ${a}\n      proxied ${b}`,
		);
	}
	await page.context().close();
}
await browser.close();
sites.close();
await done();
