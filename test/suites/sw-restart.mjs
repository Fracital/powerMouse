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
// worker nothing else starts), and so is a page's first WebSocket. A page's
// synchronous asks (document.cookie, localStorage, a synchronous
// XMLHttpRequest) are answered too: the page waits for them inside a task,
// on the thread its controller needs to hear the worker's revive on, and
// spun to the bridge's limit (10 s, 30 s for the request). Slow synchronous
// requests to a worker that is running make one handshake offer, not one
// each. Stopped over CDP, both modes, and a controller that hosts its
// transport in the page.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PORT,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();

const frameOf = (page, scope = 'stomp') =>
	page
		.frames()
		.findLast((f) => new RegExp(`/${scope}/[\\w-]+/html/`).test(f.url()));

/** the page's synchronous asks: each answers [what it got, ms] */
const SYNC_ASKS = [
	[
		'document.cookie',
		() => {
			const started = performance.now();
			const took = () => Math.round(performance.now() - started);
			try {
				document.cookie = `restart=${Date.now()}`;
				return [/restart=/.test(document.cookie), took()];
			} catch (error) {
				return [String(error).slice(0, 140), took()];
			}
		},
		true,
	],
	[
		'localStorage',
		() => {
			const started = performance.now();
			const took = () => Math.round(performance.now() - started);
			try {
				localStorage.setItem('restart', String(Date.now()));
				return [localStorage.getItem('restart') !== null, took()];
			} catch (error) {
				return [String(error).slice(0, 140), took()];
			}
		},
		true,
	],
	[
		'a synchronous XMLHttpRequest',
		() => {
			const started = performance.now();
			const took = () => Math.round(performance.now() - started);
			try {
				const request = new XMLHttpRequest();
				request.open('GET', '/echo-headers', false);
				request.send();
				return [request.status, took()];
			} catch (error) {
				return [String(error).slice(0, 140), took()];
			}
		},
		200,
	],
];
/** `ask` in the proxied page, bounded: a page that spins answers nothing meanwhile */
const asked = (frame, ask) =>
	Promise.race([
		frame.evaluate(ask).catch((error) => [String(error).slice(0, 140), 0]),
		sleep(40000).then(() => ['nothing in 40 s', 40000]),
	]);

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
	// Slow synchronous requests to a worker that is running: each waits past
	// the 300 ms after which the page tells its controller, which offers a
	// handshake in case the worker stopped. The running worker declines, and
	// no other offer follows for a while: one offer (the wasm modules and a
	// port per rewrite worker) where every other request made one. Counted
	// in the controller's realm, on the messages it posts to the worker
	{
		const realm =
			mode === 'same-origin'
				? page.mainFrame()
				: page.frames().find((f) => /controllerFrame/.test(f.url()));
		await realm.evaluate(() => {
			const proto = ServiceWorker.prototype;
			const post = proto.postMessage;
			window.__offers = {
				standby: 0,
				restore: () => (proto.postMessage = post),
			};
			proto.postMessage = function (data, transfer) {
				if (data?.['$stomp$controllerInit']?.standby) window.__offers.standby++;
				return Reflect.apply(post, this, [data, transfer]);
			};
		});
		const took = await frameOf(page).evaluate(async () => {
			const took = [];
			for (let i = 0; i < 10; i++) {
				const started = performance.now();
				const request = new XMLHttpRequest();
				request.open('GET', `/slow-js?ms=500&mark=${i}-${Date.now()}`, false);
				request.send();
				took.push(Math.round(performance.now() - started));
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			return took;
		});
		await sleep(500);
		const offers = await realm.evaluate(() => {
			window.__offers.restore();
			return window.__offers.standby;
		});
		ok(
			`${mode}: slow synchronous requests to a running worker make one handshake offer, not one each`,
			offers <= 1 && took.every((ms) => ms >= 500 && ms < 2000),
			JSON.stringify({ offers, took }),
		);
	}
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
	// The synchronous asks: the worker the page's ask started knows no
	// controller, and the controller hears its revive only once the page's
	// task ends, which waits for the answer. The page tells its controller
	// from inside the task, and the handshake is offered from there
	for (const [name, ask, wanted] of SYNC_ASKS) {
		await sleep(2500);
		await stop();
		const answer = await asked(frameOf(page), ask);
		ok(
			`${mode}: ${name} first after a restart is answered, not waited out`,
			answer[0] === wanted && answer[1] < 5000,
			JSON.stringify(answer),
		);
	}
	// and the controller is on that handshake afterwards: the host's next
	// call is answered, the page's next request too
	const after = await timed(() => {
		const started = performance.now();
		return window.controller.route('https://example.com/').then(
			(url) => [
				/\/stomp\/[\w-]+\/html\//.test(url),
				Math.round(performance.now() - started),
			],
			(error) => [`rejected: ${error.message}`, 0],
		);
	});
	const then = await status();
	ok(
		`${mode}: after it the host's calls and the page's requests answer`,
		after[0] === true && after[1] < 5000 && then === 200,
		JSON.stringify([after, then]),
	);
	await cdp.detach();
	await page.close();
}

// A controller that hosts its transport in the page: the asks the worker
// answers by itself (the jar, the storage) come through the same way. A
// synchronous request to the network does not, restart or not: its
// transport runs on the thread the page waits on (transport-worker)
{
	const page = await browser.newPage();
	const query = new URLSearchParams({
		wisp: `ws://127.0.0.1:${PORT}/wisp/`,
		transport: 'instance',
	});
	await page.goto(`${FIXTURE}pages/transport-host.html?${query}`);
	await page
		.waitForFunction(() => window.__th?.ready, null, { timeout: 60000 })
		.catch(() => {});
	const host = await page.evaluate(async () => {
		const element = document.createElement('iframe');
		document.body.append(element);
		const origin = location.origin.replace('127.0.0.1', 'localhost');
		await window.controller
			.createFrame(element)
			.go(`${origin}/pages/hist-1.html`);
		return window.__th.host;
	});
	let loaded = false;
	for (let i = 0; i < 80 && !loaded; i++) {
		await sleep(250);
		loaded =
			(await frameOf(page, 'neutral')
				?.evaluate(() => document.title)
				.catch(() => null)) === 'HIST 1';
	}
	ok(
		'in-page transport: a page loads under a controller hosted in the page',
		loaded && host === 'page',
		JSON.stringify({ loaded, host }),
	);
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('ServiceWorker.enable');
	let stops = 0;
	cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
		if (versions.some((version) => version.runningStatus === 'stopped'))
			stops++;
	});
	for (const [name, ask, wanted] of SYNC_ASKS.slice(0, 2)) {
		await sleep(2500);
		const before = stops;
		await cdp.send('ServiceWorker.stopAllWorkers');
		for (let i = 0; i < 40 && stops === before; i++) await sleep(100);
		const answer = await asked(frameOf(page, 'neutral'), ask);
		ok(
			`in-page transport: ${name} first after a restart is answered, not waited out`,
			answer[0] === wanted && answer[1] < 5000,
			JSON.stringify(answer),
		);
	}
	await cdp.detach();
	await page.close();
}

await done(browser);
