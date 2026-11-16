// Frames flow both ways on a proxied WebSocket as they do natively, on both
// transports and in both demo modes: a server that pushes while the page
// never writes, a page that answers each echo while the server keeps
// pushing, a large frame each way (several wisp packets), the server's ping
// answered, and a close the server starts and one the page starts, each
// answered. epoxy wrote a frame into the wisp stream without flushing it,
// so the page's message (and its close, and the answer to a ping or to the
// server's close) left only with the next frame or another stream's write:
// a server answering the page looked silent until the page wrote again
// (fixed by deploy/epoxy/patches/epoxy-tls/0061). What the page saw and
// what the suite's server saw are both compared with the page loaded
// natively.
import { WebSocketServer } from 'ws';
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

/** an answer the server waits for longer than this was held back */
const PROMPT_MS = 1500;
const LARGE_DOWN = 300 * 1024;
const LARGE_UP = 200 * 1024;
const pattern = (n, seed) => {
	const bytes = Buffer.alloc(n);
	for (let i = 0; i < n; i++) bytes[i] = (i * seed + 3) & 255;
	return bytes;
};

/** what the server saw, by the page's run tag and the scenario's path */
const seen = new Map();
const note = (tag, path, line) => {
	const key = `${tag} ${path}`;
	seen.set(key, [...(seen.get(key) ?? []), line]);
};
const sockets = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((resolve) => sockets.once('listening', resolve));
sockets.on('connection', (ws, req) => {
	const url = new URL(req.url, 'http://x/');
	const path = url.pathname;
	const tag = url.searchParams.get('tag');
	const log = (line) => note(tag, path, line);
	const opened = Date.now();
	const prompt = (since) =>
		Date.now() - since < PROMPT_MS ? 'prompt' : `late ${Date.now() - since}`;
	ws.on('error', (error) => log(`error ${error.message}`));
	if (path === '/push') {
		for (let i = 0; i < 5; i++) ws.send(`p${i}`);
		setTimeout(() => ws.send('p5'), 300);
	} else if (path === '/interleaved') {
		let tick = 0;
		const ticks = setInterval(() => {
			ws.send(`tick${tick}`);
			if (++tick === 6) clearInterval(ticks);
		}, 60);
		ws.on('close', () => clearInterval(ticks));
		let last = opened;
		ws.on('message', (data) => {
			log(`${data} ${prompt(last)}`);
			last = Date.now();
			ws.send(`e:${data}`);
		});
	} else if (path === '/large-down') {
		ws.send(pattern(LARGE_DOWN, 7));
	} else if (path === '/large-up') {
		ws.on('message', (data) => {
			const answer = `got ${data.length} ${data.equals(pattern(LARGE_UP, 13)) ? 'ok' : 'differs'}`;
			log(`${answer} ${prompt(opened)}`);
			ws.send(answer);
			ws.send(data);
		});
	} else if (path === '/ping') {
		let pinged;
		let answered = false;
		ws.on('pong', (data) => {
			answered = true;
			log(`pong ${data} ${prompt(pinged)}`);
			ws.send(`pong ${data}`);
		});
		setTimeout(() => {
			pinged = Date.now();
			ws.ping('pp');
		}, 50);
		setTimeout(() => answered || ws.send('no pong'), 50 + PROMPT_MS);
	} else if (path === '/server-close') {
		ws.send('bye');
		setTimeout(() => {
			const closing = Date.now();
			ws.on('close', (code, reason) =>
				log(`answered ${code} "${reason}" ${prompt(closing)}`),
			);
			ws.close(4000, 'srv');
		}, 50);
	} else if (path === '/page-close') {
		ws.on('close', (code, reason) =>
			log(`closed ${code} "${reason}" ${prompt(opened)}`),
		);
	}
});
const PAGE = `${FIXTURE}pages/websocket-frames.html?port=${sockets.address().port}`;
const SCENARIOS = {
	push: '/push',
	interleaved: '/interleaved',
	largeDown: '/large-down',
	largeUp: '/large-up',
	ping: '/ping',
	serverClose: '/server-close',
	pageClose: '/page-close',
};
/** what a run's page and the server saw, by scenario */
async function measure(frame, tag) {
	const page = await frame.evaluate((t) => window.__run(t), tag);
	// a close the page started reaches the server after the page's close event
	await sleep(500);
	const server = {};
	for (const [name, path] of Object.entries(SCENARIOS))
		server[name] = (seen.get(`${tag} ${path}`) ?? []).join(', ');
	return { page, server };
}
/** the proxied frame of a demo page that has the fixture's runner */
async function proxiedFrame(page) {
	for (let i = 0; i < 160; i++) {
		for (const frame of page
			.frames()
			.filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())))
			if (
				await frame
					.evaluate(() => typeof window.__run === 'function')
					.catch(() => false)
			)
				return frame;
		await sleep(250);
	}
	return null;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await measure(nativePage.mainFrame(), 'native');
await nativePage.close();
ok(
	'natively: every frame arrives, the server hears each message, pong and close at once',
	native.page.push === 'p0, p1, p2, p3, p4, p5' &&
		native.page.interleaved === 'e:c0,e:c1,e:c2,e:c3,e:c4 ticks 6' &&
		native.page.largeDown === 'down ok' &&
		native.page.ping === 'pong pp' &&
		native.server.interleaved ===
			'c0 prompt, c1 prompt, c2 prompt, c3 prompt, c4 prompt' &&
		native.server.ping === 'pong pp prompt' &&
		/^answered 4000 .* prompt$/.test(native.server.serverClose) &&
		native.server.pageClose === 'closed 4001 "bye" prompt',
	JSON.stringify(native),
);

// libcurl's own divergences, measured with the transport alone (no STomp in
// the path): it reports a close the server starts with no code (the page reads
// 1005), and it ends the connection without a close frame, so the server reads
// 1006 for its own close and for the page's; and it answers no ping
const KNOWN = {
	libcurl: new Set([
		'page ping',
		'server ping',
		'page serverClose',
		'server serverClose',
		'server pageClose',
	]),
};

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	for (const transport of ['epoxy', 'libcurl']) {
		const run = `${mode} ${transport}`;
		const page = await openDemo(browser, base);
		await submitLanding(page, PAGE);
		const frame = await proxiedFrame(page);
		if (!ok(`${run}: the page loads`, frame)) {
			await page.close();
			continue;
		}
		// libcurl answers no HTTP request to a loopback server through wisp
		// (transport-worker), so the page loads on epoxy and its sockets open
		// once the controller has swapped to libcurl
		if (transport === 'libcurl') {
			await page.evaluate(() => {
				const select = document.getElementById('transport');
				select.value = 'libcurl';
				select.dispatchEvent(new Event('change'));
			});
			await page
				.waitForFunction(
					() =>
						document.getElementById('chromeStatus')?.textContent === 'Ready',
					null,
					{ timeout: 30000 },
				)
				.catch(() => {});
		}
		const proxied = await measure(frame, run);
		for (const name of Object.keys(SCENARIOS))
			for (const side of ['page', 'server']) {
				const same = proxied[side][name] === native[side][name];
				const detail = `native ${JSON.stringify(native[side][name])} proxied ${JSON.stringify(proxied[side][name])}`;
				if (KNOWN[transport]?.has(`${side} ${name}`)) {
					console.log(`KNOWN ${run}: ${side} ${name} - ${detail}`);
					continue;
				}
				ok(
					`${run}: ${side === 'page' ? 'the page' : 'the server'} sees ${name} as natively`,
					same,
					detail,
				);
			}
		await page.close();
	}
}

sockets.close();
await done(browser);
