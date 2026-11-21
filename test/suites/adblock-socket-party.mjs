// A socket's party in the shields' standard mode is its top-level page's, as
// an HTTP request's is (docs/adblock.md, "mode"): standard mode leaves a
// socket to the site of the tab's page to the host's own filters and asks
// the lists of every other. A frame of another site that opens a socket to
// its own site is a third party there, and one to the top page's site is
// not. The socket check compared the socket with the origin of the document
// that opened it, so such a frame's socket to its own site skipped the lists.
//
// The page (test/pages/adblock-ws-party.html) is loaded on 127.0.0.1 and
// frames itself from localhost; each opens a socket to its own site and one
// to the other, all under a rule of a list the host names by URL for any
// party (/ws-echo?k=adblock-ws-blocked$websocket, adblock-list.txt), which
// standard mode counts as a default list. Both sites' shields are standard,
// then aggressive, where every list judges every socket.
import { done, FIXTURE, launch, ok, PROXY } from '../lib.mjs';

const browser = await launch();
const page = await browser.newPage();
await page.goto(`${PROXY}?noadblock`);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);

const run = await page.evaluate(
	async ({ fixture }) => {
		const controller = new window.StompController({
			serviceworker: window.controller.serviceworker,
			transport: window.controller.transport,
			directory: window.controller.directory.pathname,
			codec: 'xor',
			cache: false,
			adblock: {
				lists: [{ url: `${fixture}pages/adblock-list.txt`, trusted: true }],
				resources: `${fixture}pages/adblock-resources.json`,
			},
		});
		await controller.wait();
		const element = document.createElement('iframe');
		document.body.append(element);
		const frame = controller.createFrame(element);
		const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		let loads = 0;
		const load = async () => {
			const url = `${fixture}pages/adblock-ws-party.html?tag=p${loads++}`;
			const loaded = new Promise((resolve) =>
				element.addEventListener('load', resolve, { once: true }),
			);
			await frame.go(url);
			await loaded;
			const win = element.contentWindow;
			for (let i = 0; i < 100 && !win.__adblockReport; i++) await wait(50);
			if (win.__adblockReport) return await win.__adblockReport();
			// no report: what the frame shows instead, for the log
			return { missing: element.contentDocument?.title ?? null };
		};
		const opened = (sequence) =>
			Array.isArray(sequence) && sequence.some((step) => step[0] === 'open');
		const set = async (mode) => {
			for (const host of ['127.0.0.1', 'localhost'])
				controller.shields.set(host, { enabled: true, mode });
			await wait(500);
		};
		await set('standard');
		// the engine builds on the first load(s): until the top's socket to
		// the other site (a third party in either mode) is refused
		let up = null;
		for (let i = 0; i < 25; i++) {
			up = await load();
			if (up?.missing !== undefined) return { up };
			if (up && up.top.other && !opened(up.top.other)) break;
			await wait(600);
		}
		const standard = await load();
		await set('aggressive');
		const aggressive = await load();
		element.remove();
		return { up, standard, aggressive };
	},
	{ fixture: FIXTURE },
);
console.log('INFO sockets:', JSON.stringify(run));

const opened = (sequence) =>
	Array.isArray(sequence) && sequence.some((step) => step[0] === 'open');
/** refused as a socket the browser could not connect is (the adblock suite measures it) */
const refused = (sequence) =>
	Array.isArray(sequence) &&
	!opened(sequence) &&
	sequence.some((step) => step[0] === 'close' && step[2] === 1006);
const { standard, aggressive } = run;

ok(
	"standard: the top page's socket to another site is refused by the lists",
	refused(standard?.top?.other),
	JSON.stringify(standard?.top),
);
ok(
	"standard: the top page's socket to its own site is left to the host's own filters and connects",
	opened(standard?.top?.own),
	JSON.stringify(standard?.top),
);
ok(
	'standard: a frame of another site is a third party for a socket to its own site, which the lists refuse',
	refused(standard?.frame?.own),
	JSON.stringify(standard?.frame),
);
ok(
	"standard: the frame's socket to the top page's site is first-party and connects",
	opened(standard?.frame?.other),
	JSON.stringify(standard?.frame),
);
ok(
	'aggressive: every list judges every socket, so all four are refused',
	refused(aggressive?.top?.own) &&
		refused(aggressive?.top?.other) &&
		refused(aggressive?.frame?.own) &&
		refused(aggressive?.frame?.other),
	JSON.stringify(aggressive),
);

await done(browser);
