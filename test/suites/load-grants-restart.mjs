// The load gate through a service worker restart. A copy the inject makes
// for a document no service worker controls is granted by what the inject
// announced on a channel its client opened to the worker
// (src/server/loadGrants.ts), and a worker Chrome stopped keeps no channel.
// The copy that wakes the new worker is the hard one: the worker asks its
// client to open the channel again, the inject tells its last announcements
// again, and the image of another site loads as it does natively. Stopped
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
	await page.context().close();
}
await done(browser);
