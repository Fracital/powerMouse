// Dialing: a call page that goes while its call is out (src/controller/
// justCallStomp.ts dial, src/server/called.ts). The host hears no port
// close (Chrome fires no MessagePort close event), so a call page that
// goes says so, and while its call is out the host pings it: one whose
// process went, which says nothing, is taken for gone once a ping goes
// unanswered for CALL_GONE_MS. Either way the call ends then, not at the
// call's own wait (CALL_WAIT_MS, 45 s), and the tab navigates afterwards.
//
// - the tab's call page (a frame of the host's origin) sent to about:blank
//   while its call waits for a page that answers in ten seconds: the host
//   lets the frame go at once;
// - the call page made silent while its call waits (as a slot whose
//   process went): the host lets it go within the ping's bound, before the
//   page's answer would have come.
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

const WANT = 'Bookmark A';

const browser = await launch();
const errors = [];

/** the tab's call page: a frame below the demo page on `origins` */
const callPage = (page, origins) =>
	page
		.frames()
		.find(
			(frame) =>
				frame.parentFrame() === page.mainFrame() &&
				!frame.isDetached() &&
				origins.some((origin) => frame.url().startsWith(origin)) &&
				new URL(frame.url()).pathname !== new URL(page.url()).pathname,
		);

async function run(label, url, origins, end, bound) {
	const page = await openDemo(browser, url);
	await submitLanding(page, `${FIXTURE}slow-page?ms=10000`);
	let frame;
	for (const start = Date.now(); !frame && Date.now() - start < 10000;) {
		frame = callPage(page, origins(page));
		if (!frame) await sleep(100);
	}
	ok(`${label}the tab has a call page while its call waits`, !!frame);
	// (the page has said it is ready, and the call went)
	await sleep(1500);
	const gone = Date.now();
	if (frame) await end(page, frame).catch(() => {});
	let left = false;
	while (!left && Date.now() - gone < 40000) {
		left = !!frame?.isDetached();
		if (!left) await sleep(100);
	}
	const seconds = (Date.now() - gone) / 1000;
	console.log(`# ${label}the frame went after ${seconds.toFixed(1)} s`);
	ok(
		`${label}the host lets the call go within ${bound} s, not at its wait`,
		left && seconds < bound,
		`${seconds.toFixed(1)} s`,
	);
	// the tab is not stuck: its next navigation shows the page
	await submitLanding(page, `${FIXTURE}pages/bookmark-a.html`);
	let title = '';
	for (const start = Date.now(); !title && Date.now() - start < 20000;) {
		for (const shown of page.frames().slice(1))
			if ((await shown.title().catch(() => '')) === WANT) title = WANT;
		if (!title) await sleep(200);
	}
	ok(`${label}the tab navigates after`, !!title, title);
	errors.push(
		...page.errors.filter(
			(e) => !/The call page went before it answered/.test(e),
		),
	);
	await page.close();
}

await run(
	'call page gone: ',
	`${PROXY}?nopool&mode=just-call-stomp`,
	(page) => [new URL(page.url()).origin],
	(page, frame) => frame.evaluate(() => location.replace('about:blank')),
	5,
);
await run(
	'call page silent: ',
	`${PROXY}?nopool&mode=just-call-stomp`,
	(page) => [new URL(page.url()).origin],
	// (as a slot whose process went: the page is there and says nothing,
	// its pongs, its word that it goes and its answer dropped in its realm)
	(page, frame) =>
		frame.evaluate(() => {
			const post = MessagePort.prototype.postMessage;
			MessagePort.prototype.postMessage = function (message, ...rest) {
				if (message && typeof message === 'object') return;
				return Reflect.apply(post, this, [message, ...rest]);
			};
		}),
	// (unanswered for CALL_GONE_MS, 10 s, after a ping CALL_PING_MS apart)
	16,
);
await done(browser, errors);
