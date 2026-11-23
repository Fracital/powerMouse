// Dialing's frames in shadow roots (src/inject/dom/calledFrames.ts).
//
// A dialed frame's call page is caught at its load, which a capturing
// listener of the document hears. A frame's load is not composed: in a
// shadow root it ends at the root and never reaches the document, so every
// shadow root listens as the document does: one a script makes from
// attachShadow on, one of the markup (declarative) from the page's first
// read of it, or else from its call page's word that it is here. Without
// that a frame in a shadow root stays on its call page for good, and
// Turnstile, whose challenge frame is sandboxed in a closed root, never
// answers.
//
// Each frame (in an open root, a closed root, sandboxed in a closed root,
// in a closed root inside an open one, in an open and a closed
// declarative root, and in a declarative root the page never reads) is
// dialed and its document loads; the page's
// listeners, on the frame and capturing on its root, hear its load once,
// as natively, never the call page's; the page reads the frame's document
// through it; and the call page's word to its host never reaches the page.
//
// Run in plain dialing (`?nopool&mode=just-call-stomp`) and on the content
// slots (`?mode=just-call-stomp` with STOMP_SLOT_PORTS).
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const PAGES = `${FIXTURE}pages/`;
const SLOTS = (process.env.CONTENT_SLOT_PORTS ?? '')
	.split(',')
	.map(Number)
	.filter((port) => port > 0);
const MADE = [
	'open',
	'closed',
	'sandboxed',
	'nested',
	'declarativeOpen',
	'declarativeClosed',
];
const NAMES = {
	open: 'an open root',
	closed: 'a closed root',
	sandboxed: 'a closed root, sandboxed',
	nested: 'a closed root in an open one',
	declarativeOpen: 'an open declarative root of the markup',
	declarativeClosed: 'a closed declarative root of the markup',
};

const browser = await launch();
const errors = [];

async function run(label, url) {
	const page = await openDemo(browser, url);
	const children = [];
	const shadow = [];
	page.on('console', (message) => {
		const text = message.text();
		try {
			if (text.startsWith('JCS:')) children.push(JSON.parse(text.slice(4)));
			if (text.startsWith('SHADOW:')) shadow.push(JSON.parse(text.slice(7)));
		} catch (error) {
			// cut short
		}
	});
	const waitFor = async (list, pred, timeout = 30000) => {
		for (const start = Date.now(); Date.now() - start < timeout;) {
			const found = list.find(pred);
			if (found) return found;
			await sleep(100);
		}
		return null;
	};
	await submitLanding(page, `${PAGES}dial-shadow.html`);
	const loaded = await waitFor(shadow, (r) => r.why === 'load');
	const child = (name) =>
		waitFor(
			children,
			(r) =>
				r.step === 'child' &&
				r.why === 'load' &&
				r.href.includes(`?shadow-${name}`),
			loaded ? 5000 : 30000,
		);
	ok(`${label}the page loads`, !!loaded, JSON.stringify(shadow.at(-1)));
	const last = shadow.at(-1) ?? {};
	console.log(`# ${label}${JSON.stringify(last)}`);
	for (const name of MADE) {
		ok(
			`${label}a frame in ${NAMES[name]} is dialed and its document loads`,
			!!(await child(name)),
		);
		ok(
			`${label}its load is heard once on the frame and once on its root, as natively, never the call page's`,
			last[`${name}Loads`] === 1 && last[`${name}RootLoads`] === 1,
			JSON.stringify([last[`${name}Loads`], last[`${name}RootLoads`]]),
		);
		ok(
			`${label}the page reads its document through the frame`,
			last[`${name}Title`] === 'JCS child',
			JSON.stringify(last[`${name}Title`]),
		);
	}
	ok(
		`${label}a frame in a closed declarative root the page never reads is dialed and its document loads`,
		!!(await child('declarativeUnread')),
	);
	ok(
		`${label}the page hears nothing of a call page's word to its host`,
		last.heardHere === 0,
		JSON.stringify(last.heardHere),
	);
	errors.push(...page.errors);
	await page.close();
}

await run('', `${PROXY}?nopool&mode=just-call-stomp`);
if (SLOTS.length) await run('content slots: ', `${PROXY}?mode=just-call-stomp`);
else console.log('# no content slots (CONTENT_SLOT_PORTS): not run on them');
await done(browser, errors);
