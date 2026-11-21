// Content scripts in documents of the site pool's slots and of dialing's
// content slots (docs/extensions.md, "Content scripts on the slots"), with
// no network. A slot's worker keeps no extensions: it asks the hub's worker
// for a document's scripts, and the slot's agent relays the extensions'
// channels to the hub. A probe with content scripts at each run_at, in both
// worlds, all_frames or not, matches and exclude_matches on the page's
// real URL, and a userscript (userScripts.register, Tampermonkey's way),
// installed in the demo, then a page with a frame of its own site, a frame
// of another site (another slot) and a frame its entries exclude:
// - document_start runs before the page's first script, document_end in
//   the top only, document_idle after, each once per document it matches;
// - an entry that matches only the slot's URL (`/stomp/`) runs nowhere, and
//   one that excludes localhost runs everywhere but there;
// - the ISOLATED world sees none of the page's globals and the page none of
//   its, the MAIN world's are the page's;
// - runtime.sendMessage to the background and back, a port's round trip,
//   tabs.sendMessage from the background to the frame, and the user
//   script's runtime.sendMessage (configureWorld messaging);
// - the documents are on the slots' origins.
// In four arms: the same-origin host without a pool (the reference), the
// same-origin and the isolated host on the pool, and dialing on content
// slots.
import {
	activeFrame,
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	SLOTS,
	submitLanding,
} from '../lib.mjs';

const PAGE = `${FIXTURE}pages/slot-cs.html`;
const OURS = ['*://*/pages/slot-cs.html*', '*://*/pages/slot-cs-frame.html*'];
const ALL = [...OURS, '*://*/pages/slot-cs-excluded.html*'];
const EXCLUDED = ['*://*/pages/slot-cs-excluded.html*'];

const probe = {
	'manifest.json': JSON.stringify({
		manifest_version: 3,
		name: 'Slot content probe',
		version: '1.0',
		permissions: ['tabs', 'userScripts'],
		host_permissions: ['<all_urls>'],
		background: { service_worker: 'sw.js' },
		content_scripts: [
			{
				matches: ALL,
				exclude_matches: EXCLUDED,
				js: ['start.js'],
				run_at: 'document_start',
				all_frames: true,
			},
			{
				matches: ALL,
				exclude_matches: EXCLUDED,
				js: ['end.js'],
				run_at: 'document_end',
			},
			{
				matches: ALL,
				exclude_matches: EXCLUDED,
				js: ['idle.js'],
				run_at: 'document_idle',
				all_frames: true,
			},
			{
				matches: ALL,
				exclude_matches: EXCLUDED,
				js: ['main.js'],
				run_at: 'document_start',
				all_frames: true,
				world: 'MAIN',
			},
			// the real URL's host, not the slot's (127.0.0.1)
			{
				matches: ALL,
				exclude_matches: ['*://localhost/*'],
				js: ['host.js'],
				all_frames: true,
			},
			// the slot's URL is no document's
			{
				matches: ['*://*/stomp/*'],
				js: ['slot.js'],
				run_at: 'document_start',
				all_frames: true,
			},
		],
	}),
	'start.js': `const root = document.documentElement;
root.dataset.csStart = JSON.stringify({ ready: document.readyState, pageRan: root.dataset.pageScript === 'ran', runs: Number(root.dataset.csStartRuns || 0) + 1 });
root.dataset.csStartRuns = String(Number(root.dataset.csStartRuns || 0) + 1);
window.csGlobal = 'isolated';`,
	'end.js': `document.documentElement.dataset.csEnd = JSON.stringify({ ready: document.readyState, top: window === top });`,
	'idle.js': `const root = document.documentElement;
root.dataset.csIdle = JSON.stringify({ ready: document.readyState, pageGlobal: typeof window.pageGlobal, csGlobal: typeof window.csGlobal, mainGlobal: typeof window.mainGlobal });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
	if (message && message.type === 'tab-ask') respond({ at: location.pathname + location.search, top: window === top });
});
(async () => {
	const reply = await chrome.runtime.sendMessage({ type: 'ping', href: location.href });
	const port = chrome.runtime.connect({ name: 'echo' });
	const echoed = await new Promise((resolve, reject) => {
		port.onMessage.addListener((message) => resolve(message));
		port.onDisconnect.addListener(() => reject(new Error('disconnected')));
		port.postMessage({ n: 41 });
	});
	root.dataset.csReply = JSON.stringify({ reply, echoed });
})().catch((error) => {
	root.dataset.csReply = JSON.stringify({ error: String((error && error.message) || error) });
});`,
	'main.js': `window.mainGlobal = 'main';
document.documentElement.dataset.mainRan = typeof window.pageGlobal;`,
	'host.js': `document.documentElement.dataset.notLocalhost = 'ran';`,
	'slot.js': `document.documentElement.dataset.slotMatched = 'ran';`,
	'sw.js': `self.pings = [];
self.tabAnswers = [];
chrome.runtime.onInstalled.addListener(async () => {
	await chrome.userScripts.configureWorld({ messaging: true });
	await chrome.userScripts.register([{
		id: 'us',
		matches: ${JSON.stringify(ALL)},
		excludeMatches: ${JSON.stringify(EXCLUDED)},
		allFrames: true,
		runAt: 'document_idle',
		js: [{ code: "document.documentElement.dataset.us = 'ran'; chrome.runtime.sendMessage({ type: 'us' }).then((reply) => { document.documentElement.dataset.usReply = JSON.stringify(reply); }, (error) => { document.documentElement.dataset.usReply = 'error ' + error.message; });" }],
	}]);
	self.registered = true;
});
chrome.runtime.onUserScriptMessage.addListener((message, sender, respond) => {
	respond({ us: 'pong', frameId: sender.frameId, tab: !!sender.tab });
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
	if (!message || message.type !== 'ping') return;
	self.pings.push({ href: message.href, url: sender.url, tabId: sender.tab ? sender.tab.id : null, frameId: sender.frameId });
	respond({ pong: true, tabId: sender.tab ? sender.tab.id : null, frameId: sender.frameId });
	if (sender.tab)
		chrome.tabs.sendMessage(sender.tab.id, { type: 'tab-ask' }, { frameId: sender.frameId }).then(
			(answer) => self.tabAnswers.push({ href: message.href, answer }),
			(error) => self.tabAnswers.push({ href: message.href, error: error.message }),
		);
});
chrome.runtime.onConnect.addListener((port) => {
	port.onMessage.addListener((message) => port.postMessage({ n: message.n + 1 }));
});`,
};

/** the probe's files as a stored ZIP (the demo installs it as a file) */
function zip(files) {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc32 = (data) => {
		let c = 0xffffffff;
		for (const byte of data) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const data = Buffer.from(content);
		const nameBytes = Buffer.from(name);
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, nameBytes, data);
		centrals.push(central, nameBytes);
		offset += 30 + nameBytes.length + data.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}
const PROBE_ZIP = [...zip(probe)];

const parse = (text) => {
	try {
		return JSON.parse(text);
	} catch (error) {
		return undefined;
	}
};

/** one arm, at `base`: what each document says, the background's log and where the documents are */
async function arm(browser, base) {
	const page = await openDemo(browser, base);
	try {
		const id = await page.evaluate(
			async (bytes) =>
				(
					await window.controller.extensions.install(
						new Uint8Array(bytes).buffer,
						{ filename: 'slot-content-probe.zip' },
					)
				).id,
			PROBE_ZIP,
		);
		const background = async () => {
			for (let tries = 0; tries < 100; tries++) {
				for (const frame of page.frames()) {
					if (!frame.name().startsWith('ext-context:background')) continue;
					const found = await frame
						.evaluate(() =>
							globalThis.registered ? globalThis.chrome?.runtime?.id : null,
						)
						.catch(() => null);
					if (found === id) return frame;
				}
				await sleep(200);
			}
			throw new Error('the probe started no background');
		};
		let bg = await background();
		const fromBg = async (fn) => {
			try {
				return await bg.evaluate(fn);
			} catch (error) {
				bg = await background();
				return bg.evaluate(fn);
			}
		};
		await submitLanding(page, PAGE);
		let docs = null;
		const start = Date.now();
		while (Date.now() - start < 40000) {
			const top = await activeFrame(page);
			docs = await top
				?.evaluate(() =>
					window.slotDocs ? JSON.parse(JSON.stringify(window.slotDocs)) : null,
				)
				.catch(() => null);
			const settled = (doc) => doc && (doc.csReply || !doc.csStart);
			if (
				docs &&
				['top', 'same', 'cross', 'excluded'].every((w) => settled(docs[w])) &&
				['top', 'same', 'cross'].every((w) => docs[w]?.usReply)
			)
				break;
			await sleep(300);
		}
		await sleep(1000);
		const top = await activeFrame(page);
		docs =
			(await top
				?.evaluate(() =>
					window.slotDocs ? JSON.parse(JSON.stringify(window.slotDocs)) : null,
				)
				.catch(() => null)) ?? docs;
		const log = await fromBg(() => ({
			pings: self.pings,
			tabAnswers: self.tabAnswers,
		}));
		const where = top ? new URL(top.url()).origin : null;
		const origins = [
			...new Set(
				(top?.childFrames() ?? []).map((frame) => {
					try {
						return new URL(frame.url()).origin;
					} catch (error) {
						return null;
					}
				}),
			),
		];
		return { docs: docs ?? {}, log, where, origins };
	} finally {
		if (page.errors.length)
			console.log(`${base} page errors:`, JSON.stringify(page.errors));
		await page.close();
	}
}

const config = await (await fetch(`${PROXY}config.js`)).text();
const contentSlots = (
	JSON.parse(/window\.STOMP_CONFIG = (.*);\s*$/s.exec(config)[1])
		.contentSlots ?? []
).map(String);
const contentOrigins = (process.env.CONTENT_SLOT_PORTS ?? '')
	.split(',')
	.map(Number)
	.filter((port) => port > 0)
	.map((port) => `http://${new URL(PROXY).hostname}:${port}`);
const poolOrigins = SLOTS.map((slot) => new URL(slot).origin);
console.log(
	'# pool:',
	JSON.stringify(poolOrigins),
	'content slots:',
	JSON.stringify(contentOrigins),
	JSON.stringify(contentSlots),
);

const browser = await launch();
const only = process.env.ARMS ? new RegExp(process.env.ARMS) : null;
const arms = [
	['same-origin host, no pool', `${PROXY}?nopool`, null],
	['same-origin host, site pool', PROXY, poolOrigins],
	['isolated host, site pool', HOST, poolOrigins],
	['dialing, no slots', `${PROXY}?nopool&mode=just-call-stomp`, null],
	['dialing on content slots', `${PROXY}?mode=just-call-stomp`, contentOrigins],
];
for (const [mode, base, slots] of arms) {
	if (only && !only.test(mode)) continue;
	if (slots && !slots.length) {
		console.log(`# ${mode}: no slots in this run, not run`);
		continue;
	}
	let got;
	try {
		got = await arm(browser, base);
	} catch (error) {
		got = { error: String(error.stack ?? error) };
	}
	console.log(`${mode}:`, JSON.stringify(got, null, 1));
	ok(`${mode}: the arm ran`, !got.error, got.error);
	if (got.error) continue;
	const { docs, log } = got;
	if (slots)
		ok(
			`${mode}: the page is on a slot`,
			slots.includes(got.where),
			JSON.stringify([got.where, slots]),
		);
	for (const which of ['top', 'same', 'cross']) {
		const doc = docs[which] ?? {};
		const startRun = parse(doc.csStart);
		const idle = parse(doc.csIdle);
		const reply = parse(doc.csReply);
		const saw = parse(doc.pageSaw);
		ok(
			`${mode}: ${which}: document_start ran once, before the page's first script`,
			startRun?.ready === 'loading' &&
				startRun.pageRan === false &&
				doc.csStartRuns === '1',
			JSON.stringify(doc),
		);
		ok(
			`${mode}: ${which}: document_end ran ${which === 'top' ? 'in the top' : 'not in a frame (all_frames false)'}`,
			which === 'top'
				? parse(doc.csEnd)?.ready !== 'loading' &&
						parse(doc.csEnd)?.top === true
				: doc.csEnd === undefined,
			String(doc.csEnd),
		);
		ok(
			`${mode}: ${which}: document_idle ran after the parse`,
			idle && idle.ready !== 'loading',
			String(doc.csIdle),
		);
		ok(
			`${mode}: ${which}: the isolated world sees no page global, and its own`,
			idle?.pageGlobal === 'undefined' &&
				idle.csGlobal === 'string' &&
				idle.mainGlobal === 'undefined',
			String(doc.csIdle),
		);
		ok(
			`${mode}: ${which}: the page sees the MAIN world's global and not the isolated one's`,
			saw?.main === 'string' &&
				saw.isolated === 'undefined' &&
				doc.mainRan === 'undefined',
			JSON.stringify([doc.pageSaw, doc.mainRan]),
		);
		ok(
			`${mode}: ${which}: runtime.sendMessage and a port round trip with the background`,
			reply?.reply?.pong === true &&
				typeof reply.reply.tabId === 'number' &&
				reply.reply.tabId >= 0 &&
				(which === 'top'
					? reply.reply.frameId === 0
					: reply.reply.frameId > 0) &&
				reply.echoed?.n === 42,
			String(doc.csReply),
		);
		ok(
			`${mode}: ${which}: the user script ran and its message came back`,
			doc.us === 'ran' && parse(doc.usReply)?.us === 'pong',
			JSON.stringify([doc.us, doc.usReply]),
		);
		ok(
			`${mode}: ${which}: exclude_matches is read on the real URL's host`,
			which === 'cross'
				? doc.notLocalhost === undefined
				: doc.notLocalhost === 'ran',
			String(doc.notLocalhost),
		);
		ok(
			`${mode}: ${which}: an entry that matches only the slot's URL does not run`,
			doc.slotMatched === undefined,
			String(doc.slotMatched),
		);
		const href = (ping) => {
			try {
				const url = new URL(ping.href);
				return which === 'top'
					? url.pathname === '/pages/slot-cs.html'
					: url.pathname === '/pages/slot-cs-frame.html' &&
							url.searchParams.get('w') === which;
			} catch (error) {
				return false;
			}
		};
		const answers = log.tabAnswers.filter(href);
		ok(
			`${mode}: ${which}: tabs.sendMessage from the background reaches the frame`,
			answers.length === 1 &&
				answers[0].answer?.top === (which === 'top') &&
				/slot-cs/.test(answers[0].answer?.at ?? ''),
			JSON.stringify(answers),
		);
		ok(
			`${mode}: ${which}: the sender's URL is the page's real one`,
			log.pings.some((ping) => href(ping) && ping.url === ping.href),
			JSON.stringify(log.pings.filter(href)),
		);
	}
	const excluded = docs.excluded ?? {};
	ok(
		`${mode}: excluded: no entry and no user script runs in a document exclude_matches names`,
		docs.excluded &&
			!excluded.csStart &&
			!excluded.csIdle &&
			!excluded.mainRan &&
			!excluded.us &&
			excluded.notLocalhost === 'ran',
		JSON.stringify(excluded),
	);
}

await done(browser);
