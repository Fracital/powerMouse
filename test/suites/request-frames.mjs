// The host's request log names the frame a request belongs to: the host's
// frame that shows the page, whatever in the page made the request. A
// document in a nested frame, one on about:srcdoc or about:blank, a worker
// (dedicated, shared, started from a blob: URL, a nested frame's): each
// one's requests are reported with that frame, and as soon as a top-level
// document's are, not after the wait a report gets for a page that has yet
// to say where it is. A client nobody can speak for (the page's service
// worker, which is its site's and no frame's) has no frame, and holds its
// reports back for that wait once, not every time. Both controllers: same
// origin (StompController) and isolated (RemoteController, the report
// relayed by the controller frame).
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const NAMES = ['top', 'same', 'cross', 'deep'];
// what else answers a ping: documents with no URL of the proxy's, and workers
const OTHERS = {
	srcdoc: 'a document on about:srcdoc',
	blank: 'a document on about:blank',
	worker: 'a worker',
	'shared-worker': 'a shared worker',
	'blob-worker': 'a worker started from a blob: URL',
	'nested-worker': "a nested frame's worker",
};
const PINGED = [...NAMES, ...Object.keys(OTHERS)];
// how long after the page's own event (its load, its fetch's answer) a report
// may reach the host; the waits it must not sit out are 1.5 s and 3 s
const SOON_MS = 1000;

const browser = await launch();
const errors = [];
for (const [mode, base] of [
	['same origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await page.evaluate(() => {
		window.__reports = [];
		window.controller.addEventListener('request', (event) => {
			const { url, destination, frame } = event.detail;
			window.__reports.push({
				url,
				destination,
				frame: frame ? window.controller.frames.indexOf(frame) : null,
				at: Date.now(),
			});
		});
	});
	await submitLanding(page, `${FIXTURE}pages/request-frames.html`);

	// the proxied top of the tab in front: the page titled `title`
	let title = 'REQUEST FRAMES';
	const top = async () => {
		for (const frame of page
			.frames()
			.filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())))
			if (
				(await frame.evaluate(() => document.title).catch(() => '')) === title
			)
				return frame;
		return null;
	};
	// its record of when each document loaded and was answered
	const times = async () =>
		(await (await top())?.evaluate(() => window.times).catch(() => null)) ?? {
			loaded: {},
			answered: {},
		};
	const reports = () => page.evaluate(() => window.__reports);
	const documentOf = (log, name) =>
		log.find((e) =>
			name === 'top'
				? e.url.endsWith('/pages/request-frames.html')
				: e.url.includes(`request-frames-child.html?name=${name}`),
		);
	const fetchOf = (log, name) =>
		log.find((e) => e.url.endsWith(`from=${name}`));
	// what the page told and the host heard, once `done` holds of them: the
	// checks below are on when each report came, so this only has to end
	const settle = async (done) => {
		for (let i = 0; i < 240; i++) {
			const [told, log] = [await times(), await reports()];
			if (await done(told, log)) break;
			await sleep(250);
		}
		return [await times(), await reports()];
	};
	const inTop = async (call) => (await top())?.evaluate(call);

	// every document loaded and reported, then every fetch answered and
	// reported
	const [loaded, documents] = await settle((told, log) =>
		NAMES.every((name) => told.loaded[name] && documentOf(log, name)),
	);
	await inTop(() => window.ping());
	const [answered, fetches] = await settle((told, log) =>
		PINGED.every((name) => told.answered[name] && fetchOf(log, name)),
	);

	const tab = documentOf(documents, 'top')?.frame;
	ok(
		`${mode}: the top-level document's request carries its frame`,
		typeof tab === 'number' && tab >= 0,
		JSON.stringify(documentOf(documents, 'top')),
	);
	for (const name of NAMES) {
		const kind = name === 'top' ? 'the top-level' : `a nested (${name})`;
		const document = documentOf(documents, name);
		const request = fetchOf(fetches, name);
		const afterLoad = document ? document.at - loaded.loaded[name] : null;
		const afterAnswer = request ? request.at - answered.answered[name] : null;
		if (name !== 'top') {
			ok(
				`${mode}: ${kind} document's request carries the frame the page is in`,
				document?.frame === tab,
				JSON.stringify(document),
			);
			ok(
				`${mode}: ${kind} document's fetch carries the frame the page is in`,
				request?.frame === tab,
				JSON.stringify(request),
			);
		}
		ok(
			`${mode}: ${kind} document's request is reported by its load`,
			afterLoad !== null && afterLoad < SOON_MS,
			`${afterLoad} ms after the load`,
		);
		ok(
			`${mode}: ${kind} document's fetch is reported as it is answered`,
			afterAnswer !== null && afterAnswer < SOON_MS,
			`${afterAnswer} ms after the answer`,
		);
	}
	for (const [name, kind] of Object.entries(OTHERS)) {
		const request = fetchOf(fetches, name);
		const afterAnswer = request ? request.at - answered.answered[name] : null;
		ok(
			`${mode}: ${kind}'s fetch carries the frame the page is in`,
			request?.frame === tab,
			JSON.stringify(request),
		);
		ok(
			`${mode}: ${kind}'s fetch is reported as it is answered`,
			afterAnswer !== null && afterAnswer < SOON_MS,
			`${afterAnswer} ms after the answer`,
		);
	}
	// a client nobody speaks for, in a tab of its own: the first report of
	// the page's service worker sits the wait out, the second does not
	await submitLanding(page, `${FIXTURE}pages/request-frames-sw.html`);
	title = 'REQUEST FRAMES SERVICE WORKER';
	await settle(() => top());
	await inTop(() => window.ping());
	await settle((told, log) => fetchOf(log, 'service-worker-1'));
	await inTop(() => window.again());
	const [last, all] = await settle(
		(told, log) =>
			told.answered['service-worker-2'] && fetchOf(log, 'service-worker-2'),
	);
	await inTop(() => window.finish());
	for (const [name, soon] of [
		['service-worker-1', false],
		['service-worker-2', true],
	]) {
		const request = fetchOf(all, name);
		const after = request ? request.at - last.answered[name] : null;
		ok(
			`${mode}: a service worker's ${soon ? 'second' : 'first'} fetch has no frame and ${soon ? 'does not wait again' : 'waits for one once'}`,
			request?.frame === null &&
				after !== null &&
				(soon ? after < SOON_MS : after >= SOON_MS),
			`${after} ms after the answer, ${JSON.stringify(request)}`,
		);
	}
	errors.push(...page.errors);
	await page.close();
}

await done(browser, errors);
