// Windows of two origins of one site, against Chrome: what each reaches of
// the other (its document, a global, its location, its name, an iframe's
// contentDocument, frameElement), who a message's source is, and what
// document.domain and Origin-Agent-Cluster change. Chrome holds a window
// by its document's origin, and two documents of one site reach each other
// only when both set document.domain to the same value in an agent cluster
// keyed by site, which a document asks for with Origin-Agent-Cluster: ?0;
// one keyed by origin (the default) ignores the write. An origin's keying
// in a browsing context group is decided by its first document there. The
// names are under co.uk, served by test/private-sites.mjs: a site
// (stomp-a), two names under it (www, two) and another site (stomp-b).
// Every scenario in a tab of its own; natively, then through the demo in
// both modes.
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
	a: 'stomp-a.co.uk',
	sub: 'www.stomp-a.co.uk',
	two: 'two.stomp-a.co.uk',
	b: 'stomp-b.co.uk',
};
const SITE = 'stomp-a.co.uk';
let serial = 0;

/** the page on `host` as `id`, with Origin-Agent-Cluster: ?`oac` when given */
const pageURL = (host, id, oac) =>
	`${sites.origin(HOSTS[host])}/ps/ac?id=${id}${oac === undefined ? '' : `&oac=${oac}`}`;

/**
 * A driver over a tab: `frameOf(id)` finds the document of that id in any
 * page of the context, `call(id, method, ...args)` runs one of its page's
 * functions (page code, rewritten through the proxy)
 */
function driver(context) {
	const frameOf = async (id) => {
		for (let i = 0; i < 80; i++) {
			for (const page of context.pages())
				for (const frame of page.frames()) {
					const found = await frame
						.evaluate(() => window.__ac?.id ?? null)
						.catch(() => null);
					if (found === id) return frame;
				}
			await sleep(150);
		}
		throw new Error(`no document ${id}`);
	};
	const call = async (id, method, ...args) =>
		(await frameOf(id)).evaluate(
			([method, args]) => window.__ac[method](...args),
			[method, args],
		);
	return { frameOf, call };
}

/** each scenario: open its top with `visit`, then what it reads */
const SCENARIOS = {
	'same origin, the default': async (go, call, id) => {
		await go(pageURL('a', id('top')));
		await call(id('top'), 'frame', pageURL('a', id('f')));
		return {
			peek: await call(id('top'), 'peek', 0),
			parent: await call(id('f'), 'peekParent'),
		};
	},
	'a name under the site, the default': async (go, call, id) => {
		await go(pageURL('a', id('top')));
		await call(id('top'), 'frame', pageURL('sub', id('f')));
		await call(id('f'), 'hello', 'parent');
		await call(id('top'), 'hello', 0);
		await sleep(300);
		return {
			oac: [await call(id('top'), 'oac'), await call(id('f'), 'oac')],
			peek: await call(id('top'), 'peek', 0),
			parent: await call(id('f'), 'peekParent'),
			heardByTop: await call(id('top'), 'heard'),
			heardByFrame: await call(id('f'), 'heard'),
		};
	},
	'a name under the site, the default, both set the site': async (
		go,
		call,
		id,
	) => {
		await go(pageURL('a', id('top')));
		await call(id('top'), 'frame', pageURL('sub', id('f')));
		return {
			set: [
				await call(id('top'), 'setDomain', SITE),
				await call(id('f'), 'setDomain', SITE),
			],
			peek: await call(id('top'), 'peek', 0),
			parent: await call(id('f'), 'peekParent'),
		};
	},
	'Origin-Agent-Cluster: ?0 on both, both set the site': async (
		go,
		call,
		id,
	) => {
		await go(pageURL('a', id('top'), 0));
		await call(id('top'), 'frame', pageURL('sub', id('f'), 0));
		const before = await call(id('top'), 'peek', 0);
		const set = [
			await call(id('top'), 'setDomain', SITE),
			await call(id('f'), 'setDomain', SITE),
		];
		await call(id('f'), 'hello', 'parent');
		await sleep(300);
		return {
			oac: [await call(id('top'), 'oac'), await call(id('f'), 'oac')],
			before,
			set,
			peek: await call(id('top'), 'peek', 0),
			parent: await call(id('f'), 'peekParent'),
			heardByTop: await call(id('top'), 'heard'),
		};
	},
	'Origin-Agent-Cluster: ?0 on both, the parent alone sets the site': async (
		go,
		call,
		id,
	) => {
		await go(pageURL('a', id('top'), 0));
		await call(id('top'), 'frame', pageURL('sub', id('f'), 0));
		return {
			set: await call(id('top'), 'setDomain', SITE),
			peek: await call(id('top'), 'peek', 0),
			parent: await call(id('f'), 'peekParent'),
		};
	},
	'Origin-Agent-Cluster: ?0 on both, the frame sets the site, the parent its own name':
		async (go, call, id) => {
			// the parent's own host is the site: set to it, it is set all the same
			await go(pageURL('a', id('top'), 0));
			await call(id('top'), 'frame', pageURL('sub', id('f'), 0));
			return {
				set: [
					await call(id('f'), 'setDomain', SITE),
					await call(id('top'), 'setDomain', SITE),
				],
				peek: await call(id('top'), 'peek', 0),
				parent: await call(id('f'), 'peekParent'),
			};
		},
	'Origin-Agent-Cluster: ?0, same origin, the frame alone sets its own name':
		async (go, call, id) => {
			await go(pageURL('a', id('top'), 0));
			await call(id('top'), 'frame', pageURL('a', id('f'), 0));
			const set = await call(id('f'), 'setDomain', SITE);
			const alone = {
				peek: await call(id('top'), 'peek', 0),
				parent: await call(id('f'), 'peekParent'),
			};
			const both = await call(id('top'), 'setDomain', SITE);
			return {
				set,
				alone,
				both,
				peek: await call(id('top'), 'peek', 0),
				parent: await call(id('f'), 'peekParent'),
			};
		},
	'Origin-Agent-Cluster: ?0 on the parent, the frame default, both set the site':
		async (go, call, id) => {
			await go(pageURL('a', id('top'), 0));
			await call(id('top'), 'frame', pageURL('sub', id('f')));
			return {
				oac: [await call(id('top'), 'oac'), await call(id('f'), 'oac')],
				set: [
					await call(id('top'), 'setDomain', SITE),
					await call(id('f'), 'setDomain', SITE),
				],
				peek: await call(id('top'), 'peek', 0),
				parent: await call(id('f'), 'peekParent'),
			};
		},
	"an origin's keying is its first document's: the default first, then ?0":
		async (go, call, id) => {
			await go(pageURL('a', id('top')));
			await call(id('top'), 'frame', pageURL('a', id('f'), 0));
			await call(id('top'), 'frame', pageURL('sub', id('g'), 0));
			return {
				oac: [
					await call(id('top'), 'oac'),
					await call(id('f'), 'oac'),
					await call(id('g'), 'oac'),
				],
				set: [
					await call(id('f'), 'setDomain', SITE),
					await call(id('g'), 'setDomain', SITE),
				],
				// the frame of a and the frame under a reach each other?
				sibling: await call(id('g'), 'peekSibling', 0),
			};
		},
	"an origin's keying is its first document's: ?0 first, then the default":
		async (go, call, id) => {
			await go(pageURL('a', id('top'), 0));
			await call(id('top'), 'frame', pageURL('a', id('f')));
			await call(id('top'), 'frame', pageURL('sub', id('g'), 0));
			return {
				oac: [
					await call(id('top'), 'oac'),
					await call(id('f'), 'oac'),
					await call(id('g'), 'oac'),
				],
				set: [
					await call(id('f'), 'setDomain', SITE),
					await call(id('g'), 'setDomain', SITE),
				],
				sibling: await call(id('g'), 'peekSibling', 0),
			};
		},
	'two names under the site in frames, ?0, the frames set the site, the parent not':
		async (go, call, id) => {
			await go(pageURL('a', id('top'), 0));
			await call(id('top'), 'frame', pageURL('sub', id('f'), 0));
			await call(id('top'), 'frame', pageURL('two', id('g'), 0));
			return {
				set: [
					await call(id('f'), 'setDomain', SITE),
					await call(id('g'), 'setDomain', SITE),
				],
				sibling: await call(id('f'), 'peekSibling', 1),
				peek: await call(id('top'), 'peek', 0),
				parent: await call(id('f'), 'peekParent'),
			};
		},
	'another site with ?0 sets the first site, then its own': async (
		go,
		call,
		id,
	) => {
		await go(pageURL('a', id('top'), 0));
		await call(id('top'), 'frame', pageURL('b', id('f'), 0));
		return {
			set: [
				await call(id('top'), 'setDomain', SITE),
				await call(id('f'), 'setDomain', SITE),
				await call(id('f'), 'setDomain', 'stomp-b.co.uk'),
			],
			peek: await call(id('top'), 'peek', 0),
			parent: await call(id('f'), 'peekParent'),
		};
	},
	// a document's <base href> names a URL, not its origin: a page of
	// another site that names the first site's page as its base reaches
	// nothing of a window of the first site
	'another site whose <base href> is the first site, framing it': async (
		go,
		call,
		id,
	) => {
		await go(pageURL('b', id('top')));
		const base = await call(id('top'), 'setBase', `${sites.origin(HOSTS.a)}/`);
		await call(id('top'), 'frame', pageURL('a', id('f')));
		return {
			base,
			peek: await call(id('top'), 'peek', 0),
			parent: await call(id('f'), 'peekParent'),
		};
	},
	// a window keeps its identity across documents, and its access is its
	// document's: one the page held while it was of its origin is another
	// site's once the frame shows another site
	'a frame of the same origin kept, then sent to another site': async (
		go,
		call,
		id,
	) => {
		await go(pageURL('a', id('top')));
		await call(id('top'), 'frame', pageURL('a', id('f')));
		const kept = await call(id('top'), 'keep', 0);
		const before = await call(id('top'), 'reachKept');
		await call(id('top'), 'navigate', 0, pageURL('b', id('g')));
		return {
			kept,
			before,
			after: await call(id('top'), 'reachKept'),
			peek: await call(id('top'), 'peek', 0),
		};
	},
	'a popup under the site, the default': async (go, call, id) => {
		await go(pageURL('a', id('top')));
		await call(id('top'), 'open', pageURL('sub', id('p')));
		await call(id('p'), 'hello', 'opener');
		await sleep(300);
		return {
			popup: await call(id('top'), 'peekPopup'),
			opener: await call(id('p'), 'peekOpener'),
			heardByTop: await call(id('top'), 'heard'),
		};
	},
	'a popup under the site, ?0 on both, both set the site': async (
		go,
		call,
		id,
	) => {
		await go(pageURL('a', id('top'), 0));
		await call(id('top'), 'open', pageURL('sub', id('p'), 0));
		return {
			set: [
				await call(id('top'), 'setDomain', SITE),
				await call(id('p'), 'setDomain', SITE),
			],
			popup: await call(id('top'), 'peekPopup'),
			opener: await call(id('p'), 'peekOpener'),
		};
	},
};

/** what every scenario read, run in `context` with `visit` loading a top */
async function runAll(context, visit, tag, only = () => true) {
	const { call } = driver(context);
	const out = {};
	for (const [name, scenario] of Object.entries(SCENARIOS)) {
		if (!only(name)) continue;
		const n = ++serial;
		const id = (role) => `${tag}-${n}-${role}`;
		try {
			out[name] = await scenario((url) => visit(url), call, id);
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
);
await nativeBrowser.close();
for (const [name, value] of Object.entries(native))
	ok(`natively: ${name}`, !value.error, JSON.stringify(value));

/**
 * What differs from Chrome, and why: a known row that reads as natively
 * fails too, so the list stays honest
 */
const KNOWN = {
	// the page holds the browser's WindowProxy of a frame it reached while it
	// was of its origin: the frame gets a fresh browsing context before the
	// other site's document arrives (src/inject/dom/freshContext.ts), and the
	// object the page holds stays the frame's window to it, showing its old
	// document: its plain reads are of that document, not a SecurityError
	'a frame of the same origin kept, then sent to another site':
		'the held window reads its old document, of the page origin',
};

const browser = await launch([features]);
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const proxied = await runAll(
		page.context(),
		async (url) => {
			await page.click('#home').catch(() => {});
			await submitLanding(page, url);
		},
		mode,
		(name) => !name.includes('popup'),
	);
	for (const [name, value] of Object.entries(native)) {
		// the demo opens a page's popup as a tab of its own (its opener is
		// null): measured natively only
		if (name.includes('popup')) continue;
		const a = JSON.stringify(value);
		const b = JSON.stringify(proxied[name] ?? null);
		const detail = `\n      native  ${a}\n      proxied ${b}`;
		if (KNOWN[name])
			ok(
				`${mode}: ${name} differs as known (${KNOWN[name]})`,
				a !== b,
				`now as natively: take it off the list${detail}`,
			);
		else ok(`${mode}: ${name} as natively`, a === b, detail);
	}
	await page.context().close();
}
await browser.close();
sites.close();
await done();
