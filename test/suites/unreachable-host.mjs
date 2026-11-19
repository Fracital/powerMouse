// A request to a host that cannot be reached at all (a name that does not
// resolve) fails at once natively: Chrome's lookup answers in a few
// milliseconds and fetch rejects. Through STomp the wisp server refuses the
// stream as it would one it throttled, and epoxy reports both the same way,
// so the transport used to back off and try four more times, about a
// second, before the page heard. A Cloudflare challenge times exactly such
// a fetch (its IPv6-only probe host, which an IPv4-only network cannot
// reach). The transport now asks the wisp server about the destination and
// fails the request when it says unreachable. This suite times a no-cors
// fetch of a `.invalid` name natively and through the demo; the proxied
// one must reject as natively, within a fraction of the old second.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const target = `${FIXTURE}pages/blank-css.html`;
const ROUNDS = 3;

/** how a no-cors fetch of a name that does not resolve ends in `frame`, and how long it takes (ms) */
const probe = (frame) =>
	frame.evaluate(async (rounds) => {
		const out = [];
		for (let i = 0; i < rounds; i++) {
			const url = `https://stomp-unreachable-${Math.random().toString(36).slice(2)}.invalid/`;
			const t0 = performance.now();
			try {
				const response = await fetch(url, {
					mode: 'no-cors',
					cache: 'no-store',
				});
				out.push({
					result: `answered ${response.type}`,
					ms: performance.now() - t0,
				});
			} catch (error) {
				out.push({
					result: `${error.name}: ${error.message}`,
					ms: performance.now() - t0,
				});
			}
		}
		return out;
	}, ROUNDS);

const median = (runs) =>
	runs.map((r) => r.ms).sort((a, b) => a - b)[runs.length >> 1];

const browser = await launch();

const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await probe(nativePage.mainFrame());
await nativePage.close();

const page = await openDemo(browser, PROXY);
await submitLanding(page, target);
let frame;
for (let i = 0; i < 160 && !frame; i++) {
	await sleep(250);
	frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	if (
		frame &&
		!(await frame
			.evaluate(() => document.readyState === 'complete')
			.catch(() => false))
	)
		frame = undefined;
}
const proxied = frame ? await probe(frame) : [];

const show = (runs) =>
	JSON.stringify(runs.map((r) => `${r.result} in ${Math.round(r.ms)} ms`));
ok(
	'natively the fetch rejects with a TypeError',
	native.length === ROUNDS &&
		native.every((r) => r.result.startsWith('TypeError')),
	show(native),
);
ok(
	'through the proxy it rejects with the same TypeError',
	proxied.length === ROUNDS &&
		proxied.every((r, i) => r.result === native[i]?.result),
	show(proxied),
);
// natively a few ms; before the transport asked about the destination, the
// four backoffs alone took 920 ms
ok(
	'through the proxy it rejects about as soon as natively, not after a second of retries',
	proxied.length === ROUNDS && median(proxied) < 400,
	`native median ${Math.round(median(native))} ms, proxied ${Math.round(median(proxied) ?? NaN)} ms`,
);

await done(browser, page.errors);
