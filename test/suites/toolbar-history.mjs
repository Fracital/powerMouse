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

/** a frame's title and its frames' titles, `TB F [TB c1]` */
async function titles(frame) {
	if (!frame) return '';
	let title;
	try {
		title = await frame.title();
	} catch (error) {
		title = '';
	}
	const children = frame.childFrames();
	if (!children.length) return title;
	return `${title} [${(await Promise.all(children.map(titles))).join(', ')}]`;
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
		const history = await tab.cdp.send('Page.getNavigationHistory');
		return {
			url: short(tab.view.url()),
			title: await titles(tab.view.mainFrame()),
			back: history.currentIndex > 0,
			fwd: history.currentIndex < history.entries.length - 1,
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
	for (const [op, ...args] of steps) {
		if (op === 'wait') {
			await sleep(args[0]);
			continue;
		}
		await ops[op](...args.filter((arg) => arg !== 'nocheck'));
		states.push(args.includes('nocheck') ? null : await settle(read));
	}
	await context.close();
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
	const read = async () => {
		const bar = await view.evaluate(() => ({
			url: document.querySelector('#omni input').value,
			back: !document.getElementById('toolBack').disabled,
			fwd: !document.getElementById('toolForward').disabled,
			host: location.pathname,
		}));
		return {
			url: short(bar.url),
			title: await titles(await active()),
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

for (const [name, steps] of Object.entries(SEQUENCES)) {
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
