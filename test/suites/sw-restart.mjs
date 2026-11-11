// A service worker restart: Chrome stops an idle worker (or one crashes),
// and the next request starts a new one that knows no controller and asks
// them all once (revive) to shake hands again. A page's requests answer
// again within seconds, for a restart soon after the controller's handshake
// too, and for a second right after the first; the first request after a
// restart, a reload among them, waits for its controller instead of falling
// through to the host's server. Within two seconds of a handshake the
// revive was taken for the one from the worker that handshake started, so
// the controller never shook hands again and every routed request fell
// through to the host until a later restart. The host's own first act
// after a restart is carried through as well (a navigation, a call to a
// worker nothing else starts), and so is a page's first WebSocket. Stopped
// over CDP, both modes.
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
	// the page has loaded, not just its frame begun
	let loaded = false;
	for (let i = 0; i < 80 && !loaded; i++) {
		await sleep(250);
		loaded =
			(await frameOf(page)
				?.evaluate(() => document.title)
				.catch(() => null)) === 'HIST 1';
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
	const before = await status();
	ok(
		`${mode}: the page's requests answer`,
		loaded && before === 200,
		JSON.stringify({ loaded, status: before }),
	);
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
	// The host's own calls. A page that sat idle for half a minute has no
	// worker (Chrome stops one nothing reached for 30 s), so the first thing
	// its user does is the first thing after a stop: a navigation from the
	// address bar is the controller's call to the worker (route), which was
	// still waiting on the old channel when the restarted worker's
	// handshake replaced it, and was rejected ("Service worker replaced").
	// It is carried over to the new channel; and a call alone, with nothing
	// else to start the worker, starts it
	const titled = async (wanted) => {
		let found = null;
		for (let i = 0; i < 40 && found !== wanted; i++) {
			await sleep(250);
			found = await frameOf(page)
				?.evaluate(() => document.title)
				.catch(() => null);
		}
		return found;
	};
	const timed = (call, argument) =>
		Promise.race([
			page.evaluate(call, argument),
			sleep(30000).then(() => ['no answer in 30 s', 30000]),
		]);
	const go = (url) =>
		timed((url) => {
			const started = performance.now();
			const took = () => Math.round(performance.now() - started);
			return window.controller.frames
				.at(-1)
				.go(url)
				.then(
					() => ['resolved', took()],
					(error) => [`rejected: ${error.message}`, took()],
				);
		}, url);
	await sleep(2500);
	await stop();
	const went = await go(`${FIXTURE}pages/hist-2.html`);
	const landed = await titled('HIST 2');
	ok(
		`${mode}: the host's navigation right after a restart is carried through`,
		went[0] === 'resolved' && went[1] < 10000 && landed === 'HIST 2',
		JSON.stringify([...went, landed]),
	);
	// and right after that restart's handshake. The revive names the run of
	// the worker it is from, so the controller knows this one is from
	// another than the worker it just shook hands with; it used to ask the
	// stopped one over its port first, and waited a second for the silence
	await stop();
	const back = await go(`${FIXTURE}pages/hist-1.html`);
	const returned = await titled('HIST 1');
	ok(
		`${mode}: and so is one right after that restart's handshake`,
		back[0] === 'resolved' && back[1] < 10000 && returned === 'HIST 1',
		JSON.stringify([...back, returned]),
	);
	if (process.env.SKIP_TIMING !== '1')
		ok(
			`${mode}: with no second spent asking the stopped worker whether it knows the controller`,
			back[1] < 1000,
			JSON.stringify(back),
		);
	await sleep(2500);
	await stop();
	const routed = await timed(() => {
		const started = performance.now();
		const took = () => Math.round(performance.now() - started);
		return window.controller.route('https://example.com/').then(
			(url) => [/\/stomp\/[\w-]+\/html\//.test(url), took()],
			(error) => [`rejected: ${error.message}`, took()],
		);
	});
	ok(
		`${mode}: a call to a stopped worker starts it and is answered`,
		routed[0] === true && routed[1] < 10000,
		JSON.stringify(routed),
	);
	// The page's own channel: its first WebSocket asks the worker for a
	// port to the transport, and the worker that message started knew no
	// controller to pass it to and dropped it; the socket never opened and
	// never failed. The message waits for the controller like a request
	await sleep(2500);
	await stop();
	const socket = await Promise.race([
		frameOf(page)
			.evaluate(
				(url) =>
					new Promise((resolve) => {
						const started = performance.now();
						const took = () => Math.round(performance.now() - started);
						const socket = new WebSocket(url);
						socket.onmessage = () => resolve(['message', took()]);
						socket.onerror = () => resolve(['error', took()]);
						socket.onclose = (event) =>
							resolve([`closed ${event.code}`, took()]);
					}),
				`${FIXTURE.replace(/^http/, 'ws')}ws-echo`,
			)
			.catch((error) => [String(error), 0]),
		sleep(20000).then(() => ['nothing in 20 s', 20000]),
	]);
	ok(
		`${mode}: the first WebSocket a page opens right after a restart opens and hears its server`,
		socket[0] === 'message' && socket[1] < 10000,
		JSON.stringify(socket),
	);
	await cdp.detach();
	await page.close();
}

await done(browser);
