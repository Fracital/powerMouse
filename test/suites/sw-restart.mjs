// A service worker restart: Chrome stops an idle worker (or one crashes),
// and the next request starts a new one that knows no controller and asks
// them all once (revive) to shake hands again. A page's requests answer
// again within seconds, for a restart soon after the controller's handshake
// too, and for a second right after the first; the first request after a
// restart, a reload among them, waits for its controller instead of falling
// through to the host's server. Within two seconds of a handshake the
// revive was taken for the one from the worker that handshake started, so
// the controller never shook hands again and every routed request fell
// through to the host until a later restart. Stopped over CDP, both modes.
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

const browser = await launch();

const frameOf = (page) =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, `${FIXTURE}pages/hist-1.html`);
	let frame = null;
	for (let i = 0; i < 40 && !frame; i++) {
		await sleep(250);
		frame = frameOf(page);
	}
	const status = () =>
		Promise.race([
			frameOf(page)
				.evaluate(() =>
					fetch('/echo-headers').then(
						(r) => r.status,
						(e) => String(e),
					),
				)
				.catch((e) => String(e)),
			sleep(4000).then(() => 'no answer'),
		]);
	ok(`${mode}: the page's requests answer`, (await status()) === 200);
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('ServiceWorker.enable');
	let stops = 0;
	cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
		if (versions.some((version) => version.runningStatus === 'stopped'))
			stops++;
	});
	/** stop the worker and wait until it is down */
	const stop = async () => {
		const before = stops;
		await cdp.send('ServiceWorker.stopAllWorkers');
		for (let i = 0; i < 40 && stops === before; i++) await sleep(100);
	};
	/** stop the worker, then how long until the page's requests answer again (null: not within 10 s), and what the first one got */
	const restart = async () => {
		await stop();
		const started = Date.now();
		let firstStatus;
		while (Date.now() - started < 10000) {
			const answer = await status();
			firstStatus ??= answer;
			if (answer === 200) return { ms: Date.now() - started, firstStatus };
			await sleep(250);
		}
		return { ms: null, firstStatus };
	};
	const first = await restart();
	ok(
		`${mode}: after a restart the page's requests answer again`,
		first.ms !== null,
		JSON.stringify(first),
	);
	// the first request after the restart waits for its controller rather
	// than falling through to the host
	ok(
		`${mode}: the first request after a restart is answered, not a 404 from the host`,
		first.firstStatus === 200,
		JSON.stringify(first),
	);
	// at once again: this revive too lands soon after the handshake the
	// first restart caused
	const second = await restart();
	ok(
		`${mode}: after a second restart right after it, they answer again too`,
		second.ms !== null && second.firstStatus === 200,
		JSON.stringify(second),
	);
	// a navigation in the revive window: the page reloads into itself
	await sleep(2500);
	await stop();
	await frameOf(page)
		.evaluate(() => location.reload())
		.catch(() => {});
	let title = null;
	for (let i = 0; i < 40 && title !== 'HIST 1'; i++) {
		await sleep(250);
		title = await frameOf(page)
			?.evaluate(() => document.title)
			.catch(() => null);
	}
	ok(
		`${mode}: a reload right after a restart lands on the page`,
		title === 'HIST 1',
		JSON.stringify(title),
	);
	await cdp.detach();
	await page.close();
}

await done(browser);
