// The demo shows what its wisp connection rides (the controller's
// `carrier`, src/transport/wispWebTransport.ts), with a relay of holyWisp's
// design (test/wisp-wt.mjs) in front of the demo's holyWisp named as the
// session's discovery document, in the isolated and the same-origin mode:
//  - UDP up: once a page is open, the menu button's tag reads UDP, the menu's first line says
//    WebTransport (UDP) with the session's URL, and About's Transport row
//    says it too;
//  - the session lost and UDP gone with it: the next page rides the
//    WebSocket and the tag, the line and the row follow, saying why not UDP;
//  - UDP blocked from the start: TCP, and why.
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
import { startWispWebTransport } from '../wisp-wt.mjs';

const relay = await startWispWebTransport(`ws://127.0.0.1:${PORT}/wisp/`);
const browser = await launch();
const errors = [];

/** poll `read` (a function of the page) until `want(value)`, else the last value */
async function until(page, read, want, timeout = 20000) {
	const start = Date.now();
	let value;
	while (Date.now() - start < timeout) {
		value = await page.evaluate(read).catch(() => undefined);
		if (want(value)) return value;
		await sleep(150);
	}
	return value;
}

/** the demo at `base`, its config naming the relay's document */
const demo = (base) =>
	openDemo(browser, base, {}, (page) =>
		page.route('**/config.js', async (route) => {
			const response = await route.fetch();
			const text = await response.text();
			const config = JSON.parse(
				text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1),
			);
			await route.fulfill({
				response,
				body: `window.STOMP_CONFIG = ${JSON.stringify({
					...config,
					webTransport: { discovery: relay.discovery },
				})};\n`,
			});
		}),
	);

/** what the tag, the menu's line and About's Transport row (once it says `expect`) say */
async function shown(page, expect) {
	const tag = await page.evaluate(() => {
		const tag = document.getElementById('carrierTag');
		return tag.hidden
			? null
			: { text: tag.textContent, carrier: tag.dataset.carrier };
	});
	await page.click('#toolMenu');
	const line = await page.evaluate(() => {
		const line = document.getElementById('menuCarrier');
		return line.hidden ? null : line.textContent;
	});
	await page.click('#menuAbout');
	const row = await until(
		page,
		() =>
			document.querySelector('#shieldsPage [data-fact="transport"] dd')
				?.textContent ?? '',
		(value) => value.includes(expect),
		5000,
	);
	await page.keyboard.press('Escape');
	await sleep(200);
	return { tag, line, row };
}

const tagIs = (page, text) =>
	until(
		page,
		() => {
			const tag = document.getElementById('carrierTag');
			return tag.hidden ? null : tag.textContent;
		},
		(value) => value === text,
	);

for (const [mode, base] of [
	['isolated', HOST],
	['same origin', PROXY],
]) {
	// UDP up: WebTransport
	{
		relay.udpBlocked = false;
		const page = await demo(base);
		page.on('pageerror', (error) => errors.push(error.message));
		// the bar, with its menu button, shows once a page is open
		await submitLanding(page, `${FIXTURE}pages/walk-1.html`);
		let tagged = await tagIs(page, 'UDP');
		// a session up too late for the first start (a loaded machine) is
		// the next start's: what is tested here is what the demo shows
		if (tagged !== 'UDP') {
			console.log(`${mode}: the first start rode ${tagged}, starting again`);
			await page.reload();
			await page.waitForFunction(
				() => document.getElementById('logMsg').textContent === 'Ready',
			);
			await submitLanding(page, `${FIXTURE}pages/walk-1.html`);
			tagged = await tagIs(page, 'UDP');
		}
		const view = await shown(page, 'WebTransport (UDP)');
		ok(
			`${mode}: the menu button's tag reads UDP`,
			tagged === 'UDP' && view.tag?.carrier === 'webtransport',
			JSON.stringify(view.tag),
		);
		ok(
			`${mode}: the menu's first line says WebTransport (UDP) to the session`,
			/Wisp over WebTransport \(UDP\), \d+ ms/.test(view.line ?? '') &&
				view.line.includes(relay.url),
			view.line,
		);
		ok(
			`${mode}: About's Transport row says it`,
			/WebTransport \(UDP\) to /.test(view.row ?? '') &&
				view.row.includes(relay.url),
			view.row,
		);

		// the relay restarts and UDP is gone: the next page rides the
		// WebSocket, and the demo follows
		relay.udpBlocked = true;
		relay.cut();
		await submitLanding(page, `${FIXTURE}pages/walk-2.html`);
		const changed = await tagIs(page, 'TCP');
		const after = await shown(page, 'WebSocket (TCP)');
		ok(
			`${mode}: once the session is gone and UDP with it, the tag reads TCP`,
			changed === 'TCP' && after.tag?.carrier === 'websocket',
			JSON.stringify(after.tag),
		);
		ok(
			`${mode}: the menu's line and About's row say WebSocket (TCP), and why not UDP`,
			/Wisp over WebSocket \(TCP\), \d+ ms/.test(after.line ?? '') &&
				/Not UDP: \S/.test(after.line) &&
				/WebSocket \(TCP\) to .*; not UDP: \S/.test(after.row ?? ''),
			JSON.stringify(after),
		);
		await page.context().close();
	}

	// UDP blocked from the start: the WebSocket
	{
		relay.udpBlocked = true;
		const page = await demo(base);
		page.on('pageerror', (error) => errors.push(error.message));
		await submitLanding(page, `${FIXTURE}pages/walk-3.html`);
		const tagged = await tagIs(page, 'TCP');
		const view = await shown(page, 'WebSocket (TCP)');
		ok(
			`${mode} UDP blocked: the tag reads TCP`,
			tagged === 'TCP' && view.tag?.carrier === 'websocket',
			JSON.stringify(view.tag),
		);
		ok(
			`${mode} UDP blocked: the menu's line and About's row say WebSocket (TCP), and why not UDP`,
			/Wisp over WebSocket \(TCP\)/.test(view.line ?? '') &&
				/Not UDP: \S/.test(view.line) &&
				/WebSocket \(TCP\) to /.test(view.row ?? ''),
			JSON.stringify(view),
		);
		await page.context().close();
	}
}

relay.udpBlocked = false;
await relay.close();
await done(browser, errors);
