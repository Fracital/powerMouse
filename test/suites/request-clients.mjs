// A controller keeps, for the request log, which frame each service worker
// client's requests belong to, and which clients nobody spoke for. Every
// document and every worker is a new client, so what it keeps must go again:
// when the frame goes away, when the client is gone (the service worker is
// asked), and at a bound in any case. Here a tab is navigated 200 times, each
// visit four clients (the document, a nested one, one on about:srcdoc, a
// worker), frames are made and taken away again, and clients with no frame
// come and go (those of a frame that is not the host's any more) beside one
// that stays (a page's service worker); the controller's counts
// (`clientCounts`) are printed and stay small, while every report still
// carries its frame and what is still there is not waited for twice. Both
// controllers. The bound is checked in node, on the class itself
// (src/controller/clientFrames.ts), with a service worker that never
// answers; that part is left out when esbuild is not installed, as
// rewriter-unit is.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	OUT,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const VISITS = 200;
const BATCH = 20;
const FRAMES = 20;
// what one visit keeps (four clients), the frames' and the service worker
// tab's, plus what is taken in between two questions to the service worker
// (16) and while one is on its way
const KEPT = 40;
// a report this long after its fetch's answer sat a wait out (1.5 s)
const SOON_MS = 1000;

const esbuild = await import('esbuild').catch(() => null);
if (esbuild) {
	mkdirSync(OUT, { recursive: true });
	const bundle = `${OUT}request-clients-unit.mjs`;
	await esbuild.build({
		entryPoints: [
			fileURLToPath(
				new URL('../../src/controller/clientFrames.ts', import.meta.url),
			),
		],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile: bundle,
		logLevel: 'silent',
	});
	const { ClientFrames } = await import(`${bundle}?${Date.now()}`);
	const frame = { element: { isConnected: true } };
	let asked = 0;
	const clients = new ClientFrames(
		() => [frame],
		async () => {
			asked++;
			throw new Error('no service worker');
		},
	);
	for (let n = 0; n < 3000; n++) {
		clients.attribute(`client-${n}`, frame);
		clients.silence(`silent-${n}`);
		// the question is asked again once the last one failed
		if (n % 100 === 0) await sleep(0);
	}
	const { clients: kept, silent } = clients.sizes;
	ok(
		'with every frame still there and no answer from the service worker, 3000 clients and 3000 without a frame leave 1024 of each, the newest',
		kept === 1024 &&
			silent === 1024 &&
			asked > 0 &&
			clients.frame('client-2999') === frame &&
			clients.frame('client-1976') === frame &&
			clients.frame('client-1975') === null &&
			clients.silent('silent-2999') &&
			!clients.silent('silent-1975'),
		`${kept} and ${silent} kept, the service worker asked ${asked} times`,
	);
} else console.log('SKIP the bound: esbuild is not installed');

const browser = await launch();
const errors = [];
for (const [mode, base] of [
	['same origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await page.evaluate(() => {
		// the reports of the suite's fetches, by what made them, and which
		// documents were reported
		window.__from = new Map();
		window.__documents = new Set();
		window.controller.addEventListener('request', (event) => {
			const { url, frame } = event.detail;
			const document =
				/\/pages\/(request-[\w-]+\.html\?n(?:ame)?=[\w-]+)$/.exec(url)?.[1];
			if (document) window.__documents.add(document);
			const from = /[?&]from=([\w-]+)$/.exec(url)?.[1];
			if (from)
				window.__from.set(from, {
					frame: frame ? window.controller.frames.indexOf(frame) : null,
					at: Date.now(),
				});
		});
		window.__until = async (condition) => {
			for (let i = 0; i < 1200 && !condition(); i++)
				await new Promise((resolve) => setTimeout(resolve, 25));
			return !!condition();
		};
		// a visit is over when its worker's and its srcdoc document's fetches
		// were reported (the last things it does)
		window.__visit = async (frame, url, n) => {
			await frame.go(`${url}?n=${n}`);
			return window.__until(() =>
				['top', 'srcdoc', 'worker'].every((what) =>
					window.__from.has(`${what}-${n}`),
				),
			);
		};
	});
	const visitURL = `${FIXTURE}pages/request-clients.html`;
	const counts = () => page.evaluate(() => window.controller.clientCounts);

	// the tab with a page's service worker: a client with no frame
	await submitLanding(page, `${FIXTURE}pages/request-frames-sw.html`);
	const swTab = async () => {
		for (const frame of page.frames())
			if (
				(await frame.evaluate(() => document.title).catch(() => '')) ===
				'REQUEST FRAMES SERVICE WORKER'
			)
				return frame;
		return null;
	};
	const reported = (name) => page.evaluate((n) => window.__from.get(n), name);
	const pinged = async (call, name, argument) => {
		for (let i = 0; i < 240 && !(await swTab()); i++) await sleep(250);
		await (await swTab()).evaluate(call, argument);
		for (let i = 0; i < 240 && !(await reported(name)); i++) await sleep(50);
		const answered = await (
			await swTab()
		).evaluate((n) => window.times.answered[n], name);
		const report = await reported(name);
		return { ...report, after: report ? report.at - answered : null };
	};
	const first = await pinged(() => window.ping(), 'service-worker-1');
	ok(
		`${mode}: a service worker's first fetch has no frame and waited for one`,
		first.frame === null && first.after >= SOON_MS,
		JSON.stringify(first),
	);
	const before = await counts();
	ok(
		`${mode}: the service worker is kept as a client with no frame`,
		before.silent === 1,
		JSON.stringify(before),
	);

	// 200 visits in one more frame, the service worker asked for a fetch
	// every twenty (idle for 30 s, it would be stopped, and the next one
	// started is another client)
	const visits = { sizes: [], finished: 0, framed: 0 };
	const kept = [];
	for (let from = 0; from < VISITS; from += BATCH) {
		const batch = await page.evaluate(
			async ([url, from, to]) => {
				window.__visitor ??= window.controller.createFrame();
				const frame = window.__visitor;
				if (!frame.element.isConnected) document.body.append(frame.element);
				const tab = window.controller.frames.indexOf(frame);
				const sizes = [];
				let finished = 0;
				let framed = 0;
				for (let n = from; n < to; n++) {
					if (await window.__visit(frame, url, n)) finished++;
					if (
						['top', 'srcdoc', 'worker'].every(
							(what) => window.__from.get(`${what}-${n}`)?.frame === tab,
						)
					)
						framed++;
					sizes.push(window.controller.clientCounts);
				}
				return { sizes, finished, framed };
			},
			[visitURL, from, Math.min(VISITS, from + BATCH)],
		);
		visits.sizes.push(...batch.sizes);
		visits.finished += batch.finished;
		visits.framed += batch.framed;
		kept.push(
			await pinged((n) => window.keep(n), `service-worker-keep-${from}`, from),
		);
	}
	const peak = (sizes, key) => Math.max(...sizes.map((size) => size[key]));
	const last = visits.sizes.at(-1);
	ok(
		`${mode}: ${VISITS} visits of four clients each all finished, every report with the frame`,
		visits.finished === VISITS && visits.framed === VISITS,
		`${visits.finished} finished, ${visits.framed} with the frame`,
	);
	ok(
		`${mode}: after ${VISITS} navigations (${VISITS * 4} clients) the controller keeps at most ${KEPT}`,
		peak(visits.sizes, 'clients') <= KEPT && last.clients <= KEPT,
		`${last.clients} clients and ${last.silent} without a frame at the end, at most ${peak(visits.sizes, 'clients')} and ${peak(visits.sizes, 'silent')} on the way`,
	);

	// what is still there was not forgotten: the service worker's later
	// fetches never waited again, and it is still the one client kept
	// without a frame
	const waits = kept.map((report) => report.after);
	ok(
		`${mode}: a service worker that is still there is not waited for again while ${VISITS} navigations come and go`,
		kept.every((report) => report.frame === null && report.after < SOON_MS) &&
			last.silent === 1,
		`reported ${Math.min(...waits)} to ${Math.max(...waits)} ms after the answers, ${last.silent} kept without a frame`,
	);

	// frames that come and go
	const removals = await page.evaluate(
		async ([url, count]) => {
			const made = [];
			let finished = 0;
			for (let n = 0; n < count; n++) {
				const frame = window.controller.createFrame();
				document.body.append(frame.element);
				made.push(frame);
				if (await window.__visit(frame, url, `frame-${n}`)) finished++;
			}
			const withFrames = window.controller.clientCounts;
			for (const frame of made) {
				frame.element.remove();
				window.controller.frames.splice(
					window.controller.frames.indexOf(frame),
					1,
				);
			}
			// the next client the controller hears of has it look
			await window.__visit(window.__visitor, url, 'after');
			return { finished, withFrames, after: window.controller.clientCounts };
		},
		[visitURL, FRAMES],
	);
	ok(
		`${mode}: ${FRAMES} frames loaded, and their clients went with them`,
		removals.finished === FRAMES &&
			removals.withFrames.clients >= FRAMES * 3 &&
			removals.after.clients <= KEPT,
		`${removals.withFrames.clients} clients with the frames there, ${removals.after.clients} once they are gone`,
	);

	// clients with no frame that go away: those of a frame the host took
	// out of `frames` while its page was still there. Nobody speaks for
	// them, each waits once, and they go with the frame's element
	const stray = await page.evaluate(
		async ([url]) => {
			const frame = window.controller.createFrame();
			document.body.append(frame.element);
			window.controller.frames.splice(
				window.controller.frames.indexOf(frame),
				1,
			);
			const finished = await window.__visit(frame, url, 'stray');
			// its documents' own reports wait longest, and the nested one makes
			// no other request: with them everything of the frame was heard of
			const reported = await window.__until(() =>
				[
					'request-clients.html?n=stray',
					'request-frames-child.html?name=stray',
				].every((document) => window.__documents.has(document)),
			);
			const there = window.controller.clientCounts;
			frame.element.remove();
			// enough new clients for the service worker to be asked
			for (let n = 0; n < 8; n++)
				await window.__visit(window.__visitor, url, `end-${n}`);
			return {
				finished: finished && reported,
				there,
				framed: ['top', 'srcdoc', 'worker'].map(
					(what) => window.__from.get(`${what}-stray`)?.frame,
				),
				end: window.controller.clientCounts,
			};
		},
		[visitURL],
	);
	ok(
		`${mode}: the clients of a frame that is not the host's have no frame, and are not kept once it is gone`,
		stray.finished &&
			stray.framed.every((frame) => frame === null) &&
			stray.there.silent === 5 &&
			stray.end.silent === 1 &&
			stray.end.clients <= KEPT,
		`${stray.there.silent} kept without a frame while it was there, ${stray.end.silent} and ${stray.end.clients} clients at the end`,
	);
	await (await swTab())?.evaluate(() => window.finish()).catch(() => {});
	errors.push(...page.errors);
	await page.close();
}

await done(browser, errors);
