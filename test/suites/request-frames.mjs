// The host's request log names the frame a request belongs to, and a frame
// nested in a proxied page belongs to the host's frame that shows the page:
// the document request of a nested frame and the fetches it makes are
// reported with that frame, and as soon as a top-level document's are, not
// after the wait a report gets for a page that has yet to say where it is.
// A client that never says (a worker; a document on about:srcdoc) holds its
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
// what answers a ping: every document, and the top's worker
const PINGED = [...NAMES, 'worker-1'];
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

	// the top page's record of when each document loaded and was answered
	const times = async () => {
		for (const frame of page
			.frames()
			.filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()))) {
			const value = await frame
				.evaluate(() => (window.ping ? window.times : null))
				.catch(() => null);
			if (value) return value;
		}
		return { loaded: {}, answered: {} };
	};
	const reports = () => page.evaluate(() => window.__reports);
	const documentOf = (log, name) =>
		log.find((e) =>
			name === 'top'
				? e.url.endsWith('/pages/request-frames.html')
				: e.url.includes(`request-frames-child.html?name=${name}`),
		);
	const fetchOf = (log, name) =>
		log.find((e) => e.url.endsWith(`/echo-headers?from=${name}`));
	// every document loaded and reported, then every fetch answered and
	// reported: the checks below are on when, so this only has to end
	const settle = async (what, reportOf, names) => {
		for (let i = 0; i < 240; i++) {
			const [told, log] = [await times(), await reports()];
			if (names.every((name) => told[what][name] && reportOf(log, name))) break;
			await sleep(250);
		}
		return [await times(), await reports()];
	};
	const inTop = async (call) => {
		for (const frame of page.frames())
			if (await frame.evaluate(() => Boolean(window.ping)).catch(() => false))
				await frame.evaluate(call);
	};

	const [loaded, documents] = await settle('loaded', documentOf, NAMES);
	await inTop(() => window.ping());
	// the worker's first report is in once the wait for its frame ran out
	await settle('answered', fetchOf, PINGED);
	await inTop(() => window.again());
	const [answered, fetches] = await settle('answered', fetchOf, [
		...PINGED,
		'worker-2',
	]);

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
	const second = fetchOf(fetches, 'worker-2');
	const afterSecond = second ? second.at - answered.answered['worker-2'] : null;
	ok(
		`${mode}: a worker's fetch after the wait for its frame ran out is reported as it is answered`,
		afterSecond !== null && afterSecond < SOON_MS,
		`${afterSecond} ms after the answer, ${JSON.stringify(second)}`,
	);
	errors.push(...page.errors);
	await page.close();
}

await done(browser, errors);
