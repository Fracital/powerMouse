// A service worker restart: Chrome stops an idle worker (or one crashes),
// and the next request starts a new one that knows no controller and asks
// them all once (revive) to shake hands again. A page's requests answer
// again within seconds, for a restart soon after the controller's handshake
// too, and for a second right after the first. Within two seconds of a
// handshake the revive was taken for the one from the worker that handshake
// started, so the controller never shook hands again and every routed
// request fell through to the host until a later restart. Stopped over CDP,
// both modes.
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
	/** stop the worker, then how long until the page's requests answer again (null: not within 10 s) */
	const restart = async () => {
		const before = stops;
		const started = Date.now();
		await cdp.send('ServiceWorker.stopAllWorkers');
		for (let i = 0; i < 40 && stops === before; i++) await sleep(100);
		while (Date.now() - started < 10000) {
			if ((await status()) === 200) return Date.now() - started;
			await sleep(250);
		}
		return null;
	};
	const first = await restart();
	ok(
		`${mode}: after a restart the page's requests answer again`,
		first !== null,
		`${first} ms`,
	);
	// at once again: this revive too lands soon after the handshake the
	// first restart caused
	const second = await restart();
	ok(
		`${mode}: after a second restart right after it, they answer again too`,
		second !== null,
		`${second} ms`,
	);
	await cdp.detach();
	await page.close();
}

await done(browser);
