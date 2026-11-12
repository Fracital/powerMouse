// The address bar's Back and Forward go where Chrome's own buttons go for
// the same browsing in a tab of its own, and are greyed out when those are.
// Every sequence runs natively first, in a real tab whose Back and Forward
// are the mouse's back and forward buttons (Chrome's own GoBack/GoForward),
// and then through the demo in both modes, clicking the address bar's
// buttons; after each step the page shown (URL, its frames' titles) and
// whether each button is on must be the native ones.
//
// The sequences: links within a site and across sites, forward then back
// again, pushState, replaceState and fragment changes, frames in the page
// that navigate (a tab's Back steps them first, and a frame that redirects
// itself while loading adds nothing), redirects (3xx, meta refresh,
// location.replace and location.href while loading), Back while a link or
// another Back is still loading, Reload in the middle, a typed URL after
// going back, and two tabs browsed in turn: every tab of the demo is a frame
// of one page, so they share the browser's session history, where native
// tabs have one each.
import { done, FIXTURE, HOST, launch, ok, PROXY, sleep } from '../lib.mjs';

const ONE = `${FIXTURE}pages/`;
// the fixture under another name: another site
const OTHER = ONE.replace('127.0.0.1', 'localhost');
const page = (name, base = ONE, extra = '') =>
	`${base}tb.html?p=${name}${extra}`;
const framed = (name, child) =>
	page(name, ONE, `&frame=${encodeURIComponent(child)}`);
// a page that makes a history call by itself `ms` after loading, and another
const auto = (kind, to, ms = 300) =>
	`&auto=${kind}&to=${encodeURIComponent(to)}&ms=${ms}`;
const then = (kind, to, ms = 500) =>
	`&then=${kind}&to2=${encodeURIComponent(to)}&ms2=${ms}`;
const later = (name, extra) => page(name, ONE, extra);

// [operation, ...arguments]; `wait` and steps marked `nocheck` compare nothing
const SEQUENCES = {
	'links, back and forward': [
		['open', page('A')],
		['link', page('B')],
		['link', page('C')],
		['back'],
		['back'],
		['forward'],
		['back'],
	],
	'another site, forward then back': [
		['open', page('A')],
		['link', page('B', OTHER)],
		['back'],
		['forward'],
		['back'],
		['forward'],
		['link', page('C')],
		['back'],
		['back'],
		['forward'],
		['forward'],
	],
	'pushState, replaceState and fragments': [
		['open', page('A')],
		['act', 'push', '?p=A2'],
		['act', 'push', '?p=A3'],
		['act', 'replace', '?p=A3r'],
		['act', 'hash', 'h1'],
		['act', 'hash', 'h2'],
		['back'],
		['back'],
		['back'],
		['forward'],
		['forward'],
		['link', page('B')],
		['back'],
		['back'],
	],
	'frames that navigate': [
		['open', page('A')],
		['link', framed('F', 'tb.html?p=c1')],
		['child', page('c2')],
		['child', page('c3')],
		['back'],
		['back'],
		['forward'],
		['act', 'child-src', 'tb.html?p=c4'],
		['back'],
		['back'],
		['back'],
		// (going on forward is left out: Chrome then moves through the frame's
		// entries without loading them, the frame having been made anew)
		['forward'],
	],
	// a frame of the page sent to another site comes in a fresh browsing
	// context (src/inject/dom/freshContext.ts): Back still goes to its
	// document before, and Forward to the other site's again
	'a frame that goes to another site': [
		['open', page('A')],
		['link', framed('H', 'tb.html?p=h1')],
		['child', page('h2', OTHER, '&untitled=1')],
		['back'],
		['forward'],
		['back'],
		['back'],
		['forward'],
		['forward'],
	],
	'a frame that redirects itself while loading': [
		['open', page('A')],
		['link', framed('G', 'tb-assign.html')],
		['back'],
		['forward'],
		['child', page('g2')],
		['back'],
		['back'],
	],
	redirects: [
		['open', page('A')],
		['link', `${FIXTURE}sop/r?k=tb&redirect=${encodeURIComponent(page('R3'))}`],
		['link', `${ONE}tb-meta0.html`],
		['link', `${ONE}tb-replace.html`],
		['link', `${ONE}tb-assign.html`],
		['back'],
		['back'],
		['back'],
		['back'],
		['forward'],
		['forward'],
		['forward'],
		['forward'],
	],
	'Back while a link loads': [
		['open', page('A')],
		['link', page('B')],
		['link', `${FIXTURE}slow-page?ms=4000`, 'nocheck'],
		['wait', 600],
		['back'],
		['wait', 4500],
		['forward'],
	],
	'Back while Back loads': [
		['open', page('A')],
		['link', page('B')],
		['link', page('C')],
		['back', 'nocheck'],
		['wait', 150],
		['back'],
		['forward'],
		['forward'],
	],
	'Reload in the middle': [
		['open', page('A')],
		['link', page('B')],
		['link', page('C')],
		['back'],
		['reload'],
		['back'],
		['forward'],
		['forward'],
		['act', 'push', '?p=C2'],
		['reload'],
		['back'],
		['forward'],
	],
	'a typed URL after Back': [
		['open', page('A')],
		['link', page('B')],
		['back'],
		['open', page('T')],
		['back'],
		['back'],
		['forward'],
		['forward'],
	],
	// Chrome's history manipulation intervention (measured in 152 and 156):
	// Back and Forward pass over the entries of a document that sent the tab
	// on by script with no user activation, its own or carried over from a
	// document of its origin that navigated to it
	'a page that redirects by script after loading, typed': [
		['open', page('A')],
		['open', later('L', auto('assign', page('T')))],
		['back'],
		['forward'],
		['back'],
	],
	'the same reached by a link: kept once, passed over again': [
		['open', page('A')],
		['link', later('L', auto('assign', page('T')))],
		['back'],
		['back'],
		['forward'],
	],
	'the same reached by a link from another site': [
		['open', page('A', OTHER)],
		['link', later('L', auto('assign', page('T')))],
		['back'],
		['forward'],
	],
	'pushState after loading is kept, a redirect after it takes both': [
		['open', page('A')],
		['open', later('L', auto('push', '?p=L2'))],
		['back'],
		['back'],
		[
			'open',
			later('M', `${auto('push', '?p=M2')}${then('assign', page('T'))}`),
		],
		['back'],
	],
	"a frame's redirect is kept": [
		['open', page('A')],
		['open', framed('F', `tb.html?p=k${auto('assign', page('k2'))}`)],
		['back'],
	],
	'a redirecting first page: Back stays off': [
		['open', later('L', auto('assign', page('T')))],
		['back'],
		['link', page('U')],
		['back'],
		['back'],
	],
	'Reload drops the activation a link carried': [
		['open', page('A')],
		['link', later('L', auto('assign', page('T'), 2500))],
		['reload'],
		['wait', 3500],
		['back'],
	],
	'two tabs in turn': [
		['open', page('A')],
		['link', page('B')],
		['link', page('B2')],
		['back'],
		['tab', page('C')],
		['link', page('D')],
		['switch', 0],
		['back'],
		['forward'],
		['forward'],
		['back'],
		['switch', 1],
		['back'],
		['back'],
		['forward'],
		['switch', 0],
		['link', page('E')],
		['back'],
		['switch', 1],
		['back'],
	],
};

const browser = await launch();
const short = (url) =>
	String(url ?? '')
		.replaceAll(ONE, '')
		.replaceAll(OTHER, 'other:')
		.replaceAll(FIXTURE, '/');
const same = (a, b) =>
	a.url === b.url &&
	a.title === b.title &&
	a.back === b.back &&
	a.fwd === b.fwd;
const show = (s) =>
	`${s.url} "${s.title}" back ${s.back ? 'on' : 'off'}, forward ${s.fwd ? 'on' : 'off'}`;

/**
 * A window's title and its frames' titles, `TB F [TB c1]`, as an expression
 * to evaluate with no user activation: Playwright's own evaluate (and
 * title()) gives the page one, and a page with one is never passed over by
 * Chrome's history intervention
 */
const TITLES = `(function titles(w) {
	let title;
	try {
		title = w.document.title;
	} catch (error) {
		return '';
	}
	const children = [];
	for (let i = 0; i < w.length; i++) children.push(titles(w[i]));
	return children.length ? title + ' [' + children.join(', ') + ']' : title;
})`;

/** evaluate `expression` over CDP without a user activation */
async function quietly(session, expression) {
	try {
		const { result } = await session.send('Runtime.evaluate', {
			expression,
			returnByValue: true,
			userGesture: false,
		});
		return result.value ?? '';
	} catch (error) {
		return null; // between documents, or the session went with its target
	}
}

/** poll `read` until it has not changed for `still` ms */
async function settle(read, still = 500, max = 15000) {
	await sleep(150);
	const start = Date.now();
	let last = JSON.stringify(await read());
	let since = Date.now();
	while (Date.now() - start < max) {
		await sleep(100);
		const now = JSON.stringify(await read());
		if (now !== last) {
			last = now;
			since = Date.now();
		} else if (Date.now() - since >= still) break;
	}
	return JSON.parse(last);
}

/** point the page's #link somewhere and click it, as a user does */
async function clickLink(frame, url) {
	await frame.evaluate((u) => {
		document.getElementById('link').href = u;
	}, url);
	await frame.click('#link', { noWaitAfter: true });
}

/** have the page's own script make a history call, from a click */
async function act(frame, kind, url) {
	await frame.evaluate(
		([k, u]) => {
			window.tbAction = { kind: k, url: u };
		},
		[kind, url],
	);
	await frame.click('#act', { noWaitAfter: true });
}

/** the sequence in real tabs: the expected state after every step */
async function native(steps) {
	const context = await browser.newContext();
	const tabs = [];
	let tab;
	const open = async (url) => {
		const view = await context.newPage();
		const cdp = await context.newCDPSession(view);
		tab = { view, cdp };
		tabs.push(tab);
		await view.goto(url).catch(() => {});
		// a tab opened on a URL has no entry before it (a new page starts on
		// about:blank)
		await cdp.send('Page.resetNavigationHistory');
	};
	const button = async (name) => {
		for (const type of ['mousePressed', 'mouseReleased'])
			await tab.cdp.send('Input.dispatchMouseEvent', {
				type,
				x: 3,
				y: 3,
				button: name,
				buttons: type === 'mousePressed' ? (name === 'back' ? 8 : 16) : 0,
				clickCount: 1,
			});
	};
	const read = async () => {
		// the session is briefly gone while the tab swaps processes for
		// another site: read again
		const history = await tab.cdp
			.send('Page.getNavigationHistory')
			.catch(() => ({ currentIndex: -1, entries: [] }));
		return {
			url: short(tab.view.url()),
			title: (await quietly(tab.cdp, `${TITLES}(window)`)) ?? '',
			back: history.currentIndex > 0,
			fwd: history.currentIndex < history.entries.length - 1,
			entry: history.entries[history.currentIndex]?.id,
		};
	};
	const ops = {
		open: async (url) => {
			if (!tab) return open(url);
			await tab.view.goto(url).catch(() => {});
		},
		tab: open,
		switch: async (index) => {
			tab = tabs[index];
			await tab.view.bringToFront();
		},
		link: (url) => clickLink(tab.view.mainFrame(), url),
		child: (url) => clickLink(tab.view.mainFrame().childFrames()[0], url),
		act: (kind, url) => act(tab.view.mainFrame(), kind, url),
		back: () => button('back'),
		forward: () => button('forward'),
		reload: () => tab.view.reload().catch(() => {}),
	};
	const states = [];
	const ran = [];
	for (const [op, ...args] of steps) {
		if (op === 'wait') {
			await sleep(args[0]);
			continue;
		}
		await ops[op](...args.filter((arg) => arg !== 'nocheck'));
		ran.push(op);
		// a step not compared (one that is still loading) is not looked at:
		// reading the page then changed what the next press did
		states.push(args.includes('nocheck') ? null : await settle(read));
	}
	await context.close();
	// The protocol's history has no word of the entries Chrome's history
	// intervention passes over, so whether a button is on comes from its
	// index alone; a press that then moves nothing says the button was off
	// (Chrome's Back is off when every entry before is passed over), and the
	// state after it is the same
	for (let i = 1; i < states.length; i++) {
		const name = { back: 'back', forward: 'fwd' }[ran[i]];
		if (name && states[i] && states[i - 1]?.entry === states[i].entry) {
			states[i - 1][name] = false;
			states[i][name] = false;
		}
	}
	return states;
}

/** the sequence through the demo, each state compared with the native one */
async function demo(name, steps, expected, mode, base) {
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
	});
	const view = await context.newPage();
	const errors = [];
	view.on('pageerror', (error) => errors.push(error.message));
	await view.goto(base);
	await view.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: 45000 },
	);
	const active = async () => {
		const handle = await view.$('.frame:not(.hidden)');
		return handle ? handle.contentFrame() : null;
	};
	const ready = async (test) => {
		for (let i = 0; i < 150; i++) {
			const frame = await active();
			try {
				if (frame && (await frame.evaluate(test))) return frame;
			} catch (error) {
				// navigating
			}
			await sleep(100);
		}
		throw new Error('the page did not load');
	};
	const loaded = () =>
		ready(
			() =>
				document.readyState === 'complete' && !!document.getElementById('act'),
		);
	// the proxied page's titles: through the host page in same-origin mode,
	// over the frame's own CDP session in isolation (a frame of another site
	// runs in a process of its own)
	const sessions = new Map();
	const frameTitles = async () => {
		if (mode === 'same-origin')
			return (
				(await quietly(
					await viewSession(),
					`${TITLES}(document.querySelector('.frame:not(.hidden)').contentWindow)`,
				)) ?? ''
			);
		const frame = await active();
		if (!frame) return '';
		if (!sessions.has(frame))
			sessions.set(frame, await context.newCDPSession(frame).catch(() => null));
		const session = sessions.get(frame);
		const titles = session && (await quietly(session, `${TITLES}(window)`));
		if (titles === null) sessions.delete(frame);
		return titles ?? '';
	};
	let hostSession = null;
	const viewSession = async () =>
		(hostSession ??= await context.newCDPSession(view));
	const read = async () => {
		const bar = await view.evaluate(() => ({
			url: document.querySelector('#omni input').value,
			back: !document.getElementById('toolBack').disabled,
			fwd: !document.getElementById('toolForward').disabled,
			host: location.pathname,
		}));
		return {
			url: short(bar.url),
			title: await frameTitles(),
			back: bar.back,
			fwd: bar.fwd,
			host: bar.host,
		};
	};
	const submit = (form, url) =>
		view.evaluate(
			([id, u]) => {
				const element = document.getElementById(id);
				element.url.value = u;
				element.requestSubmit();
			},
			[form, url],
		);
	let opened = false;
	const ops = {
		open: async (url) => {
			await submit(opened ? 'omni' : 'mainForm', url);
			opened = true;
		},
		tab: async (url) => {
			await view.click('#home');
			await sleep(500);
			await submit('mainForm', url);
		},
		switch: async (index) => {
			// the tab manager, then the tab with the keyboard
			await view.click('#recents');
			await sleep(900);
			for (let i = 0; i < 6; i++) await view.keyboard.press('ArrowLeft');
			for (let i = 0; i < index; i++) await view.keyboard.press('ArrowRight');
			await sleep(300);
			await view.keyboard.press('Enter');
			await sleep(900);
		},
		link: async (url) => clickLink(await loaded(), url),
		child: async (url) => {
			const frame = await ready(() => !!document.getElementById('child'));
			await clickLink(frame.childFrames()[0], url);
		},
		act: async (kind, url) => act(await loaded(), kind, url),
		// a greyed-out button does nothing; the comparison says whether it
		// should have been
		back: () => view.click('#toolBack', { timeout: 3000 }).catch(() => {}),
		forward: () =>
			view.click('#toolForward', { timeout: 3000 }).catch(() => {}),
		reload: () => view.click('#toolReload'),
	};
	let index = 0;
	let failed = false;
	for (const [op, ...args] of steps) {
		if (op === 'wait') {
			await sleep(args[0]);
			continue;
		}
		const label = `${mode}: ${name}, step ${index + 1} (${op}${args.length && typeof args[0] === 'string' ? ` ${short(args[0])}` : args.length ? ` ${args[0]}` : ''})`;
		await ops[op](...args.filter((arg) => arg !== 'nocheck'));
		const want = expected[index++];
		if (!want) continue;
		// wait for the native state, then make sure it stays
		let state;
		const deadline = Date.now() + 20000;
		for (;;) {
			state = await read();
			if (same(state, want)) {
				await sleep(400);
				state = await read();
				if (same(state, want)) break;
			}
			if (Date.now() > deadline) break;
			await sleep(150);
		}
		const host =
			state.host === '/' ? '' : `, the demo page left for ${state.host}`;
		if (!same(state, want) || host) {
			ok(label, false, `${show(state)}${host}; natively ${show(want)}`);
			failed = true;
			break; // the rest of the sequence starts from the wrong place
		}
	}
	if (!failed) ok(`${mode}: ${name}`, true);
	if (errors.length) console.log(`${mode}: ${name}: page errors`, errors);
	await context.close();
}

// SEQUENCES=<words> runs the sequences whose names contain one of them
const only = process.env.SEQUENCES?.split(',');
for (const [name, steps] of Object.entries(SEQUENCES)) {
	if (only && !only.some((word) => name.includes(word))) continue;
	const expected = await native(steps);
	console.log(
		`natively, ${name}: ${expected.map((s) => (s ? `${s.url}${s.back ? ' <' : ''}${s.fwd ? ' >' : ''}` : '-')).join(' | ')}`,
	);
	// both modes at once, each in a context of its own
	await Promise.all([
		demo(name, steps, expected, 'same-origin', PROXY),
		demo(name, steps, expected, 'isolated', HOST),
	]);
}

await done(browser);
