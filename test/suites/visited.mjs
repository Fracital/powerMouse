// :visited against Chrome. Since Chrome 136 a link's visited state is kept
// per link URL, top-level site and frame origin, and a navigation is
// recorded under the site and origin of the document that started it.
// Through the proxy every link would be one partition's; the link route
// (src/visited.ts) keys the browser's own history as natively.
//
// Script cannot read :visited, so the fixture's links are coloured squares
// (test/visited-server.mjs) and the suite reads their pixels from a
// screenshot (test/visited-lib.mjs). History needs a profile that keeps it:
// each run (native, then the demo in both modes) has a persistent profile of
// its own.
//
// The sites: A (the fixture on 127.0.0.1), A2 (a second fixture port on
// 127.0.0.1: A's site, another origin), B (localhost), C (c.localhost), and
// for Chrome's self-links, which need a top-level site's own origin on its
// default port, S, S2 and W (v<port>.test, v<other port>.test and
// www.v<port>.test on port 80, which Chrome maps to the fixture with
// --host-resolver-rules and the demo's test transport by their names).
//
// Every way of visiting is made once, natively and through the proxy, each
// to URLs of its own; then every URL is shown as a link in every context
// (top-level on each site, and in a frame of each site under each) and the
// two tables are compared cell by cell. A proxied document is a frame of the
// host's page, and Chrome records a frame's navigation only when it makes a
// history entry: the visits natively recorded that make none through the
// proxy are listed with their reason (KNOWN), and must read unvisited.
// Then: what a page reads of its links and of the document a link led to
// is what it reads natively (no link route anywhere), no link route reaches
// a site, and a link is still visited after the browser restarts.
import { createServer } from 'node:net';
import { startFixture } from '../fixture.mjs';
import {
	activeFrame,
	done,
	FIXTURE,
	HOST,
	ok,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
	waitForServer,
} from '../lib.mjs';
import { launchWithHistory, readLinks } from '../visited-lib.mjs';

const freePort = () =>
	new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});

const P1 = new URL(FIXTURE).port;
let P2 = String(await freePort());
while (P2 === P1) P2 = String(await freePort());
const second = await startFixture(Number(P2));

const SITES = {
	A: `http://127.0.0.1:${P1}`,
	A2: `http://127.0.0.1:${P2}`,
	B: `http://localhost:${P1}`,
	C: `http://c.localhost:${P1}`,
	S: `http://v${P1}.test`,
	S2: `http://v${P2}.test`,
	W: `http://www.v${P1}.test`,
};
// Chrome reaches the default-port sites at the fixtures' ports
const RESOLVER = [
	`MAP v${P1}.test:80 127.0.0.1:${P1}`,
	`MAP www.v${P1}.test:80 127.0.0.1:${P1}`,
	`MAP v${P2}.test:80 127.0.0.1:${P2}`,
	'MAP * ~NOTFOUND',
	'EXCLUDE localhost',
	'EXCLUDE *.localhost',
	'EXCLUDE 127.0.0.1',
].join(', ');

const enc = encodeURIComponent;
/** the fixture's page on `site` with `params` (lists as JSON) */
const p = (site, params = {}) =>
	`${SITES[site]}/visited/p?${Object.entries(params)
		.map(
			([key, value]) =>
				`${key}=${enc(typeof value === 'string' ? value : JSON.stringify(value))}`,
		)
		.join('&')}`;
/** a page of `site` that is only ever a destination */
const t = (site, name) => `${SITES[site]}/visited/t/${name}`;
const redirect = (site, to) => `${SITES[site]}/visited/r?to=${enc(to)}`;

/** what a frame of the fixture says of itself, null while it is navigating */
const state = (frame) =>
	frame
		.evaluate(() => ({
			title: document.title,
			hash: location.hash,
			did: document.documentElement.dataset.did === '1',
		}))
		.catch(() => null);

/** wait until the frame `get()` returns shows the fixture's page of `url` */
async function landed(get, url, { did = false } = {}) {
	const want = new URL(url);
	const title = `v ${want.pathname}${want.search}`;
	for (let i = 0; i < 160; i++) {
		const frame = await get();
		const now = frame && (await state(frame));
		if (
			now &&
			now.title === title &&
			now.hash === want.hash &&
			(!did || now.did)
		)
			return frame;
		await sleep(125);
	}
	throw new Error(`never landed on ${url}`);
}

/**
 * The ways of visiting. Each makes its visit through `d` (the native or
 * the proxied driver) and names the URLs to look at afterwards with `T`.
 */
const VISITS = {
	async click(d, T) {
		const u = T('a link clicked', t('C', 'click'));
		const top = await d.open(p('A', { l: [u] }));
		await top.click('#l0');
		await landed(d.top, u);
	},
	async scriptLink(d, T) {
		const u = T('a link a script made, clicked', t('C', 'script-link'));
		const top = await d.open(p('A', { sl: [u] }));
		await top.click('#l0');
		await landed(d.top, u);
	},
	async svgLink(d, T) {
		const u = T('an SVG link clicked', t('C', 'svg-link'));
		const top = await d.open(p('A', { l: [u], kind: 'svg' }));
		await top.click('#l0');
		await landed(d.top, u);
	},
	async typed(d, T) {
		const u = T('typed', t('C', 'typed'));
		await d.open(u);
	},
	async assignClick(d, T) {
		const u = T('location.href, on a click', t('C', 'assign-click'));
		const top = await d.open(p('A', { do: 'assign', to: u }));
		await top.click('#go');
		await landed(d.top, u);
	},
	async assignLoad(d, T) {
		const u = T('location.href, after load', t('C', 'assign-load'));
		await d.open(p('A', { do: 'assign', to: u, when: 'load' }), u);
	},
	async redirectChain(d, T) {
		const u = T('a redirect: where it ends', t('C', 'redirected'));
		const hop = T("a redirect: the link's own URL", redirect('B', u));
		const top = await d.open(p('A', { l: [hop] }));
		await top.click('#l0');
		await landed(d.top, u);
	},
	async typedRedirect(d, T) {
		const u = T('a typed redirect: where it ends', t('C', 'typed-redirected'));
		const hop = T('a typed redirect: the typed URL', redirect('B', u));
		await d.open(hop, u);
	},
	async pushState(d, T) {
		const u = T('pushState', t('A', 'pushed'));
		const top = await d.open(p('A', { do: 'push', to: u, t: 'push' }));
		await top.click('#go');
		await landed(d.top, p('A', { do: 'push', to: u, t: 'push' }), {
			did: true,
		});
	},
	async hash(d, T) {
		const base = p('A', { do: 'hash', to: 'frag', t: 'hash' });
		T('location.hash: the page without it (typed)', base);
		const u = T('location.hash: with the fragment', `${base}#frag`);
		T('location.hash: another fragment', `${base}#other`);
		const top = await d.open(base);
		await top.click('#go');
		await landed(d.top, u);
	},
	async fragment(d, T) {
		const base = t('C', 'fragment');
		T('a link with a fragment: the URL without it', base);
		const u = T('a link with a fragment: clicked', `${base}#f1`);
		T('a link with a fragment: another fragment', `${base}#f2`);
		const top = await d.open(p('A', { l: [u] }));
		await top.click('#l0');
		await landed(d.top, u);
	},
	async frameInitial(d, T) {
		const u = T("a frame's first document", t('C', 'frame-initial'));
		const top = await d.open(p('A', { f: [u] }));
		await landed(() => top.childFrames()[0], u);
	},
	async frameLink(d, T) {
		const u = T('a link clicked in a frame of B under A', t('C', 'frame-link'));
		const top = await d.open(p('A', { f: [p('B', { l: [u] })] }));
		const frame = await landed(() => top.childFrames()[0], p('B', { l: [u] }));
		await frame.click('#l0');
		await landed(() => top.childFrames()[0], u);
		d.kinds?.push(top.childFrames()[0].url());
	},
	async framePush(d, T) {
		const u = T('pushState in a frame of B under A', t('B', 'frame-pushed'));
		const inner = p('B', { do: 'push', to: u, when: 'load' });
		const top = await d.open(p('A', { f: [inner] }));
		await landed(() => top.childFrames()[0], inner, { did: true });
	},
	async frameAssign(d, T) {
		const u = T(
			'location.href in a frame of B under A',
			t('C', 'frame-assign'),
		);
		const inner = p('B', { do: 'assign', to: u, when: 'load' });
		const top = await d.open(p('A', { f: [inner] }));
		await landed(() => top.childFrames()[0], u);
	},
	async frameReplace(d, T) {
		const u = T(
			'location.replace in a frame of B under A',
			t('C', 'frame-replace'),
		);
		const inner = p('B', { do: 'replace', to: u, when: 'load' });
		const top = await d.open(p('A', { f: [inner] }));
		await landed(() => top.childFrames()[0], u);
	},
	async srcdocLink(d, T) {
		const u = T('a link clicked in a srcdoc frame of A', t('C', 'srcdoc-link'));
		const top = await d.open(p('A', { sd: [u] }));
		await sleep(500);
		await top.childFrames()[0].click('#l0');
		await landed(() => top.childFrames()[0], u);
		d.kinds?.push(top.childFrames()[0].url());
	},
	async ownFragment(d, T) {
		const base = p('A', { l: ['#own'], t: 'own-fragment' });
		T("a link to the page's own fragment: the page (typed)", base);
		const u = T("a link to the page's own fragment: clicked", `${base}#own`);
		const top = await d.open(base);
		await top.click('#l0');
		await landed(d.top, u);
	},
	async scriptClick(d, T) {
		const u = T('a link a script clicks', t('C', 'script-click'));
		const top = await d.open(p('A', { do: 'aclick', to: u }));
		await top.click('#go');
		await landed(d.top, u);
	},
	async assignment(d, T) {
		const u = T('location = url', t('C', 'assignment'));
		const top = await d.open(p('A', { do: 'set', to: u }));
		await top.click('#go');
		await landed(d.top, u);
	},
	async openSelf(d, T) {
		const u = T('window.open on the window itself', t('C', 'open-self'));
		const top = await d.open(p('A', { do: 'openself', to: u }));
		await top.click('#go');
		await landed(d.top, u);
	},
	async entryListener(d, T) {
		const u = T(
			'a link on a page that listens for currententrychange',
			t('C', 'entry-listener'),
		);
		const top = await d.open(p('A', { l: [u], nav: 'change' }));
		await top.click('#l0');
		await landed(d.top, u);
	},
	async form(d, T) {
		const action = t('C', 'form');
		const u = T('a GET form', `${action}?q=1`);
		const top = await d.open(p('A', { do: 'form', to: action }));
		await top.click('#go');
		await landed(d.top, u);
	},
	// Chrome's self-links: a visit from a top-level site's own origin (its
	// registrable domain, on the default port) counts for the visited URL's
	// own site too
	async selfLink(d, T) {
		const u = T("a link clicked on a site's own origin", t('C', 'self'));
		const top = await d.open(p('S', { l: [u] }));
		await top.click('#l0');
		await landed(d.top, u);
	},
	async selfLinkRedirect(d, T) {
		const u = T(
			"a redirect from a site's own origin: where it ends",
			t('C', 'self-redirected'),
		);
		const hop = T(
			"a redirect from a site's own origin: the link's own URL",
			redirect('B', u),
		);
		const top = await d.open(p('S', { l: [hop] }));
		await top.click('#l0');
		await landed(d.top, u);
	},
	async selfPush(d, T) {
		const u = T("pushState on a site's own origin", t('S', 'self-pushed'));
		const top = await d.open(p('S', { do: 'push', to: u, t: 'self-push' }));
		await top.click('#go');
		await landed(d.top, p('S', { do: 'push', to: u, t: 'self-push' }), {
			did: true,
		});
	},
	async subdomainLink(d, T) {
		const u = T("a link clicked on a site's www origin", t('C', 'www'));
		const top = await d.open(p('W', { l: [u] }));
		await top.click('#l0');
		await landed(d.top, u);
	},
	// natively recorded, through the proxy not (KNOWN)
	async replace(d, T) {
		const u = T('location.replace', t('C', 'replace'));
		const top = await d.open(p('A', { do: 'replace', to: u }));
		await top.click('#go');
		await landed(d.top, u);
	},
	async replaceState(d, T) {
		const u = T('history.replaceState', t('A', 'replaced-state'));
		const top = await d.open(p('A', { do: 'replaceState', to: u, t: 'rs' }));
		await top.click('#go');
		await landed(d.top, p('A', { do: 'replaceState', to: u, t: 'rs' }), {
			did: true,
		});
	},
	async assignEarly(d, T) {
		const u = T('location.href while the page is parsed', t('C', 'early'));
		// (no user's activation: nothing is asked of the frame meanwhile)
		await d.open(p('A', { do: 'assign', to: u, when: 'early' }), u, {
			quiet: true,
		});
	},
	async metaRefresh(d, T) {
		const u = T('a meta refresh', t('C', 'meta'));
		await d.open(p('A', { meta: u }), u);
	},
	async popup(d, T) {
		const u = T('window.open in a new window', t('C', 'popup'));
		const top = await d.open(p('A', { do: 'open', to: u }));
		await d.popup(() => top.click('#go'), u);
	},
	async blankLink(d, T) {
		const u = T('a link that opens a new window', t('C', 'blank-link'));
		const top = await d.open(p('A', { l: [u], tb: 1 }));
		await d.popup(() => top.click('#l0'), u);
	},
	async frameSrc(d, T) {
		const u = T("a frame's src set by its page", t('C', 'frame-src'));
		const first = t('A', 'frame-first');
		const top = await d.open(p('A', { f: [first], do: 'frame', to: u }));
		await landed(() => top.childFrames()[0], first);
		await top.click('#go');
		await landed(() => top.childFrames()[0], u);
	},
	async navigateListener(d, T) {
		const u = T(
			'a link on a page that listens for navigate',
			t('C', 'navigate-listener'),
		);
		const top = await d.open(p('A', { l: [u], nav: 'listen' }));
		await top.click('#l0');
		await landed(d.top, u);
	},
	async entryListenerPush(d, T) {
		const u = T(
			'pushState on a page that listens for currententrychange',
			t('A', 'entry-listener-pushed'),
		);
		const page = p('A', { do: 'push', to: u, nav: 'change' });
		const top = await d.open(page);
		await top.click('#go');
		await landed(d.top, page, { did: true });
	},
};

// Natively recorded, through the proxy not: every proxied document is a
// frame of the host's page, and the browser's history takes a frame's
// navigation only when it makes a history entry (history_tab_helper.cc:
// HasSubframeNavigationEntryCommitted). The same visits made in a frame are
// not recorded natively either (the frame rows above). Each must read
// unvisited everywhere: never a visit the browser did not see.
const NO_ENTRY = 'replaces the entry of a frame: no history entry is made';
const FRESH_CONTEXT =
	"another origin's document comes in a fresh browsing context: no history entry is made";
const KNOWN = {
	'location.replace': NO_ENTRY,
	'history.replaceState': NO_ENTRY,
	'location.href while the page is parsed': `a navigation before the load event ${NO_ENTRY}`,
	'a meta refresh': `a client redirect ${NO_ENTRY}`,
	'window.open in a new window':
		"the host opens the tab: its first document is a new frame's, which makes no entry",
	'a link that opens a new window':
		"the host opens the tab: its first document is a new frame's, which makes no entry",
	"a frame's src set by its page":
		"the frame's kind of route is its own, which the link route does not carry: the document's address is navigated",
	'a link on a page that listens for navigate':
		'the page may intercept the navigation, which commits the URL it names: the link is followed at the document address',
	'pushState on a page that listens for currententrychange':
		'the entry would be made in two steps the page would hear of: it is made at the document address',
	// a frame that is to show another origin gets a fresh browsing context
	// (src/inject/dom/freshContext.ts), whose first document makes none
	'a link clicked in a frame of B under A': FRESH_CONTEXT,
	'location.href in a frame of B under A': FRESH_CONTEXT,
	'a link clicked in a srcdoc frame of A': FRESH_CONTEXT,
};

/** where every URL is looked at: top-level on a site, or `[top, frame]` */
const CONTEXTS = [
	['A'],
	['A2'],
	['B'],
	['C'],
	['A', 'A'],
	['A2', 'A'],
	['A', 'A2'],
	['A', 'B'],
	['A2', 'B'],
	['B', 'A'],
	['B', 'B'],
	['C', 'C'],
	['S'],
	['W'],
	['S', 'S'],
	['W', 'S'],
	['S', 'W'],
];
const CHUNK = 25;

/** every visit made through `d`, then every URL read in every context: `{ label: { context: visited } }` */
async function table(d) {
	const targets = [];
	const T = (label, url) => {
		targets.push([label, url]);
		return url;
	};
	const failed = [];
	for (const [name, visit] of Object.entries(VISITS)) {
		if (process.env.VISITS && !process.env.VISITS.split(',').includes(name))
			continue;
		try {
			await visit(d, T);
		} catch (error) {
			failed.push(`${name}: ${String(error.message).split('\n')[0]}`);
		}
		// the history thread writes behind the navigation
		await sleep(400);
	}
	await sleep(1500);
	const result = Object.fromEntries(targets.map(([label]) => [label, {}]));
	for (const context of CONTEXTS) {
		for (let at = 0; at < targets.length; at += CHUNK) {
			const chunk = targets.slice(at, at + CHUNK);
			const site = context[context.length - 1];
			const inner = p(site, {
				l: chunk.map(([, url]) => url),
				o: `${context.join('-')}-${at}`,
			});
			let seen;
			try {
				let frame;
				if (context.length === 1) frame = await d.open(inner);
				else {
					const top = await d.open(p(context[0], { f: [inner] }));
					frame = await landed(() => top.childFrames()[0], inner);
				}
				await sleep(300);
				seen = await readLinks(d.page, frame, chunk.length);
			} catch (error) {
				failed.push(
					`reading ${context.join('/')}: ${String(error.message).split('\n')[0]}`,
				);
				continue;
			}
			chunk.forEach(([label], i) => {
				result[label][context.join('/')] = seen[i];
			});
		}
	}
	return { result, failed };
}

/** Chrome itself: a typed navigation is page.goto */
function nativeDriver(page) {
	return {
		page,
		top: () => page.mainFrame(),
		open: async (url, lands = url) => {
			// (a page that navigates at once interrupts the load goto waits for)
			await page.goto(url).catch(() => {});
			return landed(() => page.mainFrame(), lands);
		},
		popup: async (trigger, lands) => {
			const [popup] = await Promise.all([
				page.context().waitForEvent('page'),
				trigger(),
			]);
			await landed(() => popup.mainFrame(), lands);
			await popup.close();
		},
	};
}

/**
 * Wait until the page's frames have navigated and stopped, asking the page
 * nothing. To Chrome an evaluation is a user's gesture (Playwright evaluates
 * with `userGesture`), and one that reaches a frame's document before its
 * own script runs gives it the activation a visit may depend on having not.
 */
async function settled(page) {
	let count = 0;
	let last = Date.now();
	const navigated = (frame) => {
		if (frame === page.mainFrame()) return;
		count++;
		last = Date.now();
	};
	page.on('framenavigated', navigated);
	const start = Date.now();
	while (Date.now() - start < 15000 && (count < 2 || Date.now() - last < 1000))
		await sleep(100);
	page.off('framenavigated', navigated);
}

/** the demo: a typed navigation is the address bar's, in the one tab */
function proxiedDriver(page) {
	let opened = false;
	return {
		page,
		/** the addresses of the documents links led to in nested frames */
		kinds: [],
		top: () => activeFrame(page),
		open: async (url, lands = url, { quiet = false } = {}) => {
			const still = quiet && settled(page);
			if (opened) await submitOmni(page, url);
			else await submitLanding(page, url);
			opened = true;
			await still;
			return landed(() => activeFrame(page), lands);
		},
		// the demo opens a tab, which is the active one from here on
		popup: async (trigger, lands) => {
			await trigger();
			await landed(() => activeFrame(page), lands);
		},
	};
}

/** what a document says of itself and of the navigation that made it */
const whereAmI = () => {
	const [entry] = performance.getEntriesByType('navigation');
	const activation = navigation.activation;
	return {
		url: document.URL,
		base: document.baseURI,
		referrer: document.referrer,
		name: entry.name,
		type: entry.type,
		redirectCount: entry.redirectCount,
		redirected: entry.redirectStart > 0,
		json: entry.toJSON().redirectCount,
		serverTiming: entry.serverTiming.map((metric) => metric.name),
		legacyCount: performance.navigation.redirectCount,
		legacyRedirected: performance.timing.redirectStart > 0,
		current: navigation.currentEntry.url,
		entries: navigation
			.entries()
			.slice(-2)
			.map((item) => item.url),
		activation: activation && {
			from: activation.from ? activation.from.url : null,
			entry: activation.entry.url,
			type: activation.navigationType,
		},
		length: history.length,
	};
};
const linksAsRead = () =>
	[...document.querySelectorAll('a, area')].map((link) => ({
		href: typeof link.href === 'string' ? link.href : link.href.baseVal,
		attribute: link.getAttribute('href'),
		outer: link.outerHTML,
		parts:
			typeof link.href === 'string'
				? [link.protocol, link.host, link.pathname, link.search, link.hash]
				: null,
		text: typeof link.href === 'string' ? String(link) : null,
		listed: [...document.links].includes(link),
	}));

/**
 * What pages read of their links and of the documents links lead to, made
 * through `d`: the same calls natively and through the proxy, compared as
 * JSON
 */
async function observations(d) {
	const seen = {};
	const note = async (name, make) => {
		try {
			seen[name] = await make();
		} catch (error) {
			seen[name] = `failed: ${String(error.message).split('\n')[0]}`;
		}
	};
	const dest = t('C', 'seen');
	const own = t('A', 'seen-own');
	await note('links as the page reads them', async () => {
		const top = await d.open(
			p('A', {
				l: [dest, own, '#part', '/visited/t/rel?x=1#y', '', `${dest}#`],
				sl: [`${dest}#made`, '?q'],
				t: 'seen',
			}),
		);
		return {
			links: await top.evaluate(linksAsRead),
			markup: await top.evaluate(
				() => document.body.innerHTML.split('<script')[0],
			),
		};
	});
	await note('SVG links as the page reads them', async () => {
		const top = await d.open(p('A', { l: [dest, '#part'], kind: 'svg' }));
		return top.evaluate(linksAsRead);
	});
	await note('areas as the page reads them', async () => {
		const top = await d.open(p('A', { l: [dest, '#part'], kind: 'area' }));
		return top.evaluate(linksAsRead);
	});
	const follow = async (source, lands) => {
		const top = await d.open(source);
		const before = await top.evaluate(() => history.length);
		await top.click('#l0');
		const at = await landed(d.top, lands);
		const here = await at.evaluate(whereAmI);
		here.length -= before;
		return here;
	};
	await note('the document a link led to, on its own origin', () =>
		follow(p('A', { l: [own], t: 'seen-a' }), own),
	);
	await note('the document a link led to, on another site', () =>
		follow(p('A', { l: [dest], t: 'seen-c' }), dest),
	);
	await note("the document a link led to, on a site's own origin", () =>
		follow(p('S', { l: [t('C', 'seen-s')] }), t('C', 'seen-s')),
	);
	await note("the document a site's redirect on one origin led to", () =>
		follow(
			p('A', { l: [redirect('A', t('A', 'seen-r'))], t: 'seen-r' }),
			t('A', 'seen-r'),
		),
	);
	await note("the document a site's redirect across origins led to", () =>
		follow(
			p('A', { l: [redirect('B', t('C', 'seen-x'))], t: 'seen-x' }),
			t('C', 'seen-x'),
		),
	);
	await note('the document a GET form led to', async () => {
		const action = t('C', 'seen-form');
		const top = await d.open(p('A', { do: 'form', to: action }));
		await top.click('#go');
		const at = await landed(d.top, `${action}?q=1`);
		const here = await at.evaluate(whereAmI);
		delete here.length;
		return here;
	});
	await note('entries a page makes without loading', async () => {
		const page = p('A', {
			l: ['#part'],
			do: 'push',
			to: t('A', 'seen-pushed'),
		});
		const top = await d.open(page);
		const before = await top.evaluate(() => history.length);
		await top.evaluate(() => {
			window.heard = [];
			for (const type of ['hashchange', 'popstate'])
				addEventListener(type, (event) =>
					window.heard.push(
						[type, event.oldURL, event.newURL, event.isTrusted].join(' '),
					),
				);
			history.replaceState({ kept: 1 }, '');
		});
		await top.click('#l0');
		await sleep(300);
		const afterFragment = await top.evaluate(() => ({
			href: document.URL,
			state: history.state,
			target: !!document.querySelector(':target'),
			length: history.length,
			heard: window.heard,
		}));
		afterFragment.length -= before;
		await top.click('#go');
		await sleep(300);
		const afterPush = await top.evaluate(() => ({
			href: document.URL,
			state: history.state,
			length: history.length,
			entries: navigation
				.entries()
				.slice(-3)
				.map((item) => item.url),
			heard: window.heard,
		}));
		afterPush.length -= before;
		await top.evaluate(() => history.back());
		await sleep(500);
		const afterBack = await top.evaluate(() => ({
			href: document.URL,
			state: history.state,
			heard: window.heard,
		}));
		return { afterFragment, afterPush, afterBack };
	});
	await note(
		'what a page that listens for navigate hears, and takes over',
		async () => {
			const spa = `${SITES.A}/visited/spa/one`;
			const page = p('A', {
				l: [spa, '#part'],
				do: 'push',
				to: t('A', 'heard-pushed'),
				nav: 'intercept',
			});
			const top = await d.open(page);
			const before = await top.evaluate(() => history.length);
			await top.click('#l1');
			await sleep(200);
			await top.click('#go');
			await sleep(200);
			await top.click('#l0');
			await sleep(500);
			const after = await top.evaluate(() => ({
				href: document.URL,
				title: document.title,
				log: window.navlog,
				length: history.length,
				links: [...document.querySelectorAll('a')].map((link) => link.href),
				entries: navigation
					.entries()
					.slice(-4)
					.map((item) => item.url),
			}));
			after.length -= before;
			return after;
		},
	);
	return seen;
}

const row = (cells) =>
	CONTEXTS.map((context) => (cells[context.join('/')] ? 'V' : '.')).join(' ');

const all = '. '.repeat(CONTEXTS.length).trim();
// VISITS=<names> makes only those visits (and none of the checks that need
// them all); OBSERVE=1 with it still makes the observations
const OBSERVE = !process.env.VISITS || process.env.OBSERVE === '1';
const logOf = async (site) =>
	(await fetch(`${SITES[site]}/visited/log`)).json().catch(() => []);

const nativeRun = await launchWithHistory([], RESOLVER);
const nativePage =
	nativeRun.context.pages()[0] ?? (await nativeRun.context.newPage());
const native = await table(nativeDriver(nativePage));
// (in a tab of their own: a tab's history is 50 entries at most, and the
// observations count them)
const nativeSeen = !OBSERVE
	? {}
	: await observations(nativeDriver(await nativeRun.context.newPage()));
await nativeRun.close();
ok('natively, every visit and reading was made', !native.failed.length, [
	...native.failed,
]);
console.log(`     contexts: ${CONTEXTS.map((c) => c.join('/')).join(' ')}`);
for (const [label, cells] of Object.entries(native.result))
	console.log(`     native   ${row(cells)}  ${label}`);
// what the comparison relies on, so a change in the browser shows here first
const nativeRow = (label) => row(native.result[label] ?? {});
if (!process.env.VISITS) {
	ok(
		'natively, a clicked link is visited on its own site and origin only',
		nativeRow('a link clicked') === 'V . . . V V . . . . . . . . . . .',
		nativeRow('a link clicked'),
	);
	ok(
		"natively, a link clicked on a site's own origin is visited on the visited URL's site too",
		nativeRow("a link clicked on a site's own origin") ===
			'. . . V . . . . . . . V V . V V .',
		nativeRow("a link clicked on a site's own origin"),
	);
	ok(
		"natively, a link clicked on a site's www origin is not",
		nativeRow("a link clicked on a site's www origin") ===
			'. . . . . . . . . . . . . V . . V',
		nativeRow("a link clicked on a site's www origin"),
	);
	for (const label of Object.keys(KNOWN))
		ok(
			`natively, ${label} is recorded`,
			nativeRow(label) !== all,
			nativeRow(label),
		);
}
if (OBSERVE) {
	ok(
		'natively, every observation was made',
		!Object.values(nativeSeen).some((value) => typeof value === 'string'),
		JSON.stringify(nativeSeen).slice(0, 600),
	);
}
await logOf('A');
await logOf('A2');

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	if (process.env.MODES && !process.env.MODES.split(',').includes(mode))
		continue;
	const run = await launchWithHistory([], RESOLVER);
	const errors = [];
	const start = async (context) => {
		await waitForServer(base);
		const page = context.pages()[0] ?? (await context.newPage());
		await page.setViewportSize({ width: 1280, height: 800 });
		page.on('pageerror', (error) => errors.push(error.message));
		await page.goto(base);
		await page.waitForFunction(
			() =>
				/^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
			null,
			{ timeout: 45000 },
		);
		return page;
	};
	let page = await start(run.context);
	const driver = proxiedDriver(page);
	const proxied = await table(driver);
	// (the link route names no kind of route: the worker takes the frame's
	// from the navigation's referrer, or from the document itself when a
	// page wrote it, whose referrer is its parent's address)
	ok(
		`${mode}: a link followed in a nested frame leads to a nested document's address`,
		driver.kinds.length === (process.env.VISITS ? driver.kinds.length : 2) &&
			driver.kinds.every((url) => /\/html:nested:[^/]+\//.test(url)),
		JSON.stringify(driver.kinds),
	);
	ok(`${mode}: every visit and reading was made`, !proxied.failed.length, [
		...proxied.failed,
	]);
	for (const [label, cells] of Object.entries(native.result)) {
		const want = row(cells);
		const got = row(proxied.result[label] ?? {});
		if (label in KNOWN)
			ok(
				`${mode}: ${label} is not recorded (${KNOWN[label]})`,
				got === all,
				`\n      native  ${want}\n      proxied ${got}`,
			);
		else
			ok(
				`${mode}: ${label} as natively`,
				want === got,
				`\n      native  ${want}\n      proxied ${got}`,
			);
	}
	if (OBSERVE) {
		await page.close();
		page = await start(run.context);
		const seen = await observations(proxiedDriver(page));
		for (const [name, want] of Object.entries(nativeSeen))
			ok(
				`${mode}: ${name}, as natively`,
				JSON.stringify(seen[name]) === JSON.stringify(want),
				`\n      native  ${JSON.stringify(want)}\n      proxied ${JSON.stringify(seen[name])}`,
			);
		ok(
			`${mode}: no page read a link route or the proxy's address`,
			!/~\/|\/stomp\//.test(JSON.stringify(seen)) &&
				!JSON.stringify(seen).includes(new URL(PROXY).host),
			JSON.stringify(seen).match(/.{0,80}(~\/|\/stomp\/).{0,80}/)?.[0],
		);
	}
	// The host: the address it asks the controller for is the document's
	// (a typed navigation, which records nothing), a link's route as the
	// browser has it reads back as the real URL, and a frame the host sends
	// to one arrives at the page
	if (OBSERVE)
		try {
			const d = proxiedDriver(page);
			const target = `${t('C', 'host')}#part`;
			const top = await d.open(p('A', { l: [target], t: 'host' }));
			// (the attribute as the browser has it: playwright reads it in a
			// world of its own, past the page's hooks)
			const written = await (await top.$('#l0')).getAttribute('href');
			const linkRoute = new URL(written, top.url()).href;
			const host = await page.evaluate(
				async ([routed, real]) => {
					const address = await window.controller.route(real);
					return {
						address,
						back: await window.controller.unroute(address),
						link: await window.controller.unroute(routed),
						other: await window.controller.unroute('https://example.com/'),
					};
				},
				[linkRoute, target],
			);
			ok(
				`${mode}: a link is routed as its link route, with its fragment`,
				/\/~\/[^/?#]+#part$/.test(linkRoute),
				linkRoute,
			);
			ok(
				`${mode}: controller.route() is the document's address, as before`,
				/\/[\w-]+\/html\/[^/?#]+#part$/.test(host.address) &&
					!host.address.includes('/~/'),
				host.address,
			);
			ok(
				`${mode}: controller.unroute() reads both back, and nothing else`,
				host.back === target && host.link === target && host.other === null,
				JSON.stringify(host),
			);
			await page.evaluate((routed) => {
				document.querySelector('.frame:not(.hidden)').src = routed;
			}, linkRoute);
			await landed(d.top, target).then(
				() =>
					ok(`${mode}: a frame the host sends to a link route arrives`, true),
				(error) =>
					ok(
						`${mode}: a frame the host sends to a link route arrives`,
						false,
						error.message,
					),
			);
		} catch (error) {
			ok(`${mode}: the host's side`, false, error.message);
		}
	// what reached the sites: their own URLs, from their own pages
	const requests = [...(await logOf('A')), ...(await logOf('A2'))];
	const real = Object.values(SITES).map((site) => new URL(site).host);
	const foreign = requests.filter(
		(request) =>
			/~|%7E/i.test(request.url.split('?')[0]) ||
			(request.referer !== '' &&
				!real.includes(new URL(request.referer).host)) ||
			/~\//.test(request.referer),
	);
	ok(
		`${mode}: no link route reached a site (${requests.length} requests)`,
		requests.length > (process.env.VISITS ? 0 : 100) && !foreign.length,
		JSON.stringify(foreign.slice(0, 3)),
	);
	// the link route names no controller and no session: after a restart
	// (a new host page, a new controller) the visit still shows
	await run.close({ keep: true });
	const again = await launchWithHistory([], RESOLVER, run.profile);
	if (!process.env.VISITS)
		try {
			const d = proxiedDriver(await start(again.context));
			const clicked = [
				t('C', 'click'),
				t('C', 'typed'),
				t('A', 'pushed'),
				`${t('C', 'fragment')}#f1`,
			];
			const frame = await d.open(p('A', { l: clicked, o: 'again' }));
			await sleep(500);
			const read = await readLinks(d.page, frame, clicked.length);
			ok(
				`${mode}: after the browser restarts, what was visited still is`,
				JSON.stringify(read) === JSON.stringify([true, false, true, true]),
				JSON.stringify(read),
			);
		} catch (error) {
			ok(`${mode}: after the browser restarts`, false, error.message);
		}
	ok(`${mode}: no page error`, !errors.length, errors.join('; '));
	await again.close();
}

second.close();
await done(null);
