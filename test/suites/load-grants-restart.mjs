// The load gate through a service worker restart. A copy the inject makes
// for a document no service worker controls is granted by what the inject
// announced on a channel its client opened to the worker
// (src/server/loadGrants.ts), and a worker Chrome stopped keeps no channel.
// The copy that wakes the new worker is the hard one: the worker asks its
// client to open the channel again, the inject tells its last announcements
// again, and the image of another site loads as it does natively. Stopped
// over CDP, both modes.
//
// A restarted worker served none of the documents it finds, so it cannot
// know whose the first channel a client offers is: it challenges the client
// with a nonce and takes the channel that comes back with it. A realm of the
// page that passed every hook (the browser's natives, taken before the
// inject ran) offers channels until one is taken, and answers the nonce
// too: none is, and what it announces grants it nothing.
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
// the natives a page that passed every hook would have; it uses them only
// once the page runs, after the inject's bundle
const NATIVES = `window.__lgrNative = {
	container: navigator.serviceWorker,
	controller: Object.getOwnPropertyDescriptor(ServiceWorkerContainer.prototype, 'controller').get,
	post: ServiceWorker.prototype.postMessage,
	listen: EventTarget.prototype.addEventListener,
	data: Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get,
	start: MessagePort.prototype.start,
	portPost: MessagePort.prototype.postMessage,
	Channel: MessageChannel,
	fetch: window.fetch,
	text: Response.prototype.text,
	getAttribute: Element.prototype.getAttribute,
};`;
const other = new URL(FIXTURE.replace('127.0.0.1', 'localhost')).origin;
const frameOf = (page) =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));

/** an image of another site in a new about:blank frame: its width once it settled */
const blankImage = (frame, url) =>
	Promise.race([
		frame
			.evaluate(
				(url) =>
					new Promise((resolve) => {
						const made = document.createElement('iframe');
						document.body.append(made);
						const image = made.contentDocument.createElement('img');
						image.onload = () => resolve(image.naturalWidth);
						image.onerror = () => resolve('error');
						made.contentDocument.body.append(image);
						image.src = url;
					}),
				url,
			)
			.catch((error) => String(error)),
		sleep(8000).then(() => 'no answer'),
	]);

const nativePage = await browser.newPage();
await nativePage.goto(`${FIXTURE}pages/hist-1.html`);
ok(
	'natively, an image of another site loads in an about:blank frame',
	(await blankImage(
		nativePage.mainFrame(),
		`${other}/sop/r?type=png&k=lgr-native`,
	)) === 1,
);
await nativePage.close();

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await page.context().addInitScript(NATIVES);
	await submitLanding(page, `${FIXTURE}pages/hist-1.html`);
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		if (
			(await frameOf(page)
				?.evaluate(() => document.title)
				.catch(() => null)) === 'HIST 1'
		)
			break;
	}
	let serial = 0;
	const image = () =>
		blankImage(
			frameOf(page),
			`${other}/sop/r?type=png&k=lgr-${mode}-${++serial}`,
		);
	ok(`${mode}: the copy loads`, (await image()) === 1);
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('ServiceWorker.enable');
	let stops = 0;
	cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
		if (versions.some((version) => version.runningStatus === 'stopped'))
			stops++;
	});
	const stop = async () => {
		const before = stops;
		await cdp.send('ServiceWorker.stopAllWorkers');
		for (let i = 0; i < 40 && stops === before; i++) await sleep(100);
	};
	await stop();
	const first = await image();
	ok(
		`${mode}: the copy that wakes a restarted worker loads`,
		first === 1,
		JSON.stringify(first),
	);
	const next = await image();
	ok(`${mode}: and the one after it`, next === 1, JSON.stringify(next));
	await stop();
	const [a, b, c] = await Promise.all([image(), image(), image()]);
	ok(
		`${mode}: three at once on a second restart load`,
		a === 1 && b === 1 && c === 1,
		JSON.stringify([a, b, c]),
	);
	await sleep(1500);
	const settled = await image();
	ok(
		`${mode}: and one after the worker asked every client to shake hands again`,
		settled === 1,
		JSON.stringify(settled),
	);

	// the attack: on a restarted worker, the page's realm offers a channel
	// before the inject does, answers the nonce the worker challenges with,
	// and announces a read of another site's text on whatever is taken
	await stop();
	const attack = await frameOf(page)
		.evaluate(async (target) => {
			const N = window.__lgrNative;
			const image = new Image();
			image.src = target;
			const url = N.getAttribute.call(image, 'src');
			const controller = N.controller.call(N.container);
			const offers = [];
			const nonces = [];
			const mint = () =>
				Array.from(
					crypto.getRandomValues(new Uint8Array(22)),
					(byte) =>
						'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[
							byte & 63
						],
				).join('');
			const offer = (answer) => {
				const channel = new N.Channel();
				const record = { answer: answer ?? null, taken: false, token: mint() };
				offers.push(record);
				const port = channel.port1;
				N.listen.call(port, 'message', () => {
					record.taken = true;
					N.portPost.call(port, {
						token: record.token,
						url,
						load: 'image no-cors',
					});
				});
				N.start.call(port);
				N.post.call(
					controller,
					{
						$stomp$loadChannel: answer
							? { directory: '/stomp/', answer }
							: { directory: '/stomp/' },
					},
					[channel.port2],
				);
			};
			N.listen.call(
				N.container,
				'message',
				(event) => {
					const nonce = N.data.call(event)?.$stomp$swRevive?.load;
					if (typeof nonce !== 'string') return;
					nonces.push(nonce);
					offer(nonce);
				},
				true,
			);
			// until one is taken: a restarted worker takes none before its
			// controller registered again
			for (let i = 0; i < 25 && !offers.some((record) => record.taken); i++) {
				offer();
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
			const reads = [];
			const read = offers.filter((record) => record.taken);
			for (const { token } of read.length ? read : offers.slice(-1))
				try {
					const response = await N.fetch.call(window, url, {
						headers: { 'x-stomp-load': token },
					});
					reads.push(await N.text.call(response));
				} catch (error) {
					reads.push(String(error));
				}
			return {
				offers: offers.length,
				taken: offers.filter((record) => record.taken).length,
				nonces: nonces.length,
				reads,
			};
		}, `${other}/sop/r?type=text&k=lgr-${mode}-attack`)
		.catch((error) => ({ error: String(error) }));
	ok(
		`${mode}: a channel the page offers first on a restarted worker, or with the nonce, is not taken`,
		attack.offers >= 2 && attack.nonces >= 1 && attack.taken === 0,
		JSON.stringify(attack),
	);
	ok(
		`${mode}: and what it announces reads nothing of another site`,
		attack.reads?.length >= 1 &&
			attack.reads.every((read) => !read.includes('SECRET-BODY')),
		JSON.stringify(attack.reads),
	);
	const after = await image();
	ok(
		`${mode}: the inject's copies load after the attack`,
		after === 1,
		JSON.stringify(after),
	);

	// the second: the page's own getters of a channel's ports, which the
	// inject would use for the channel it opens again on a restarted worker
	// (the port it transfers would be one the page holds the other end of)
	const secret = `${other}/sop/r?type=text&k=lgr-${mode}-getters`;
	await frameOf(page).evaluate(() => {
		const port1 = Object.getOwnPropertyDescriptor(
			MessageChannel.prototype,
			'port1',
		);
		const port2 = Object.getOwnPropertyDescriptor(
			MessageChannel.prototype,
			'port2',
		);
		const held = [];
		const swapped = new WeakMap();
		Object.defineProperty(MessageChannel.prototype, 'port2', {
			...port2,
			get() {
				if (!swapped.has(this)) {
					const mine = new MessageChannel();
					const near = port1.get.call(mine);
					const record = { taken: false };
					near.onmessage = () => (record.taken = true);
					held.push({ port: near, record });
					swapped.set(this, port2.get.call(mine));
				}
				return swapped.get(this);
			},
		});
		window.__lgrHeld = {
			held,
			restore: () =>
				Object.defineProperty(MessageChannel.prototype, 'port2', port2),
		};
	});
	await stop();
	await image();
	await sleep(1500);
	const hijack = await frameOf(page)
		.evaluate(async (target) => {
			const N = window.__lgrNative;
			const { held, restore } = window.__lgrHeld;
			restore();
			const image = new Image();
			image.src = target;
			const url = N.getAttribute.call(image, 'src');
			const taken = held.filter(({ record }) => record.taken);
			const reads = [];
			for (const { port } of taken) {
				const token = Array.from(
					crypto.getRandomValues(new Uint8Array(22)),
					(byte) =>
						'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[
							byte & 63
						],
				).join('');
				N.portPost.call(port, { token, url, load: 'image no-cors' });
				await new Promise((resolve) => setTimeout(resolve, 100));
				try {
					const response = await N.fetch.call(window, url, {
						headers: { 'x-stomp-load': token },
					});
					reads.push(await N.text.call(response));
				} catch (error) {
					reads.push(String(error));
				}
			}
			return { swapped: held.length, taken: taken.length, reads };
		}, secret)
		.catch((error) => ({ error: String(error) }));
	ok(
		`${mode}: the page's getters of a channel's ports hand it no channel the inject opens again`,
		hijack.taken === 0 && hijack.reads?.length === 0,
		JSON.stringify(hijack),
	);
	const later = await image();
	ok(
		`${mode}: and the inject's copies load after it`,
		later === 1,
		JSON.stringify(later),
	);
	await page.context().close();
}
await done(browser);
