// A proxied WebTransport stream's writes settle as the bytes leave, as
// natively: an upload over a slow uplink to a server that grants a long
// path's flow control (the suite's server, test/wtserver.mjs, with 16 MiB
// stream windows and its received datagrams through a 24 Mbit/s link)
// counts, at each mark, about what the link carried, natively and through
// the proxy. stomp-h3's writes settled once quinn took the bytes into its
// send buffer, which flow control and quinn's 15 MiB send window bound: a
// speed test counting its settled writes read the page's own speed through
// the proxy (deploy/epoxy/h3/src/wt.rs, `until_sent`).
import {
	activeFrame,
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
import {
	STOMP_H3,
	webTransportClient,
	writesSettleAsSent,
} from '../webtransport-env.mjs';
import { startWebTransportServer } from '../wtserver.mjs';

if (!webTransportClient) {
	console.log(
		`SKIP webtransport-buffered: the stomp-h3 epoxy-transport ships has no WebTransport client (${STOMP_H3} exports no connect_webtransport)`,
	);
	process.exit(0);
}

const MIB = 1048576;
const MBPS = 24;
const TOTAL = 8 * MIB;
const MARKS = [500, 1000, 2000];
/** what may be settled beyond what natively is at a mark (Chrome's own buffer, the proxy's) */
const SLACK = MIB;

const server = await startWebTransportServer({
	streamWindow: 16 * MIB,
	uplinkMbps: MBPS,
});
const browser = await launch([
	`--ignore-certificate-errors-spki-list=${server.spki}`,
	`--origin-to-force-quic-on=127.0.0.1:${server.port}`,
]);

let runs = 0;
const pageURL = () => {
	const search = new URLSearchParams({
		port: server.port,
		hash: server.certHash,
		bytes: TOTAL,
		marks: MARKS.join(),
		run: `b${++runs}`,
	});
	return {
		run: `b${runs}`,
		url: `${FIXTURE}pages/webtransport-buffered.html?${search}`,
	};
};
async function answer(frame, run, timeout = 40000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const value = await (
			await frame()
		)
			?.evaluate((run) => (window.__wt?.run === run ? window.__wt : null), run)
			.catch(() => null);
		if (value) return value.result;
		await sleep(150);
	}
	return 'the page never answered';
}

const linkMs = (TOTAL * 8) / (MBPS * 1000);
const made = pageURL();
const tab = await browser.newPage();
await tab.goto(made.url);
const native = await answer(() => tab.mainFrame(), made.run);
await tab.close();
console.log('native', JSON.stringify(native), `link ${Math.round(linkMs)} ms`);
ok(
	'natively: the server reads every byte, over about the link time, and what settled at each mark is about what the link carried',
	native?.counted === TOTAL &&
		native.ms >= linkMs * 0.8 &&
		native.at.every(
			(settled, i) =>
				settled === undefined ||
				settled === null ||
				settled <= (MARKS[i] * MBPS * 1000) / 8 + SLACK,
		),
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const run = pageURL();
	await submitLanding(page, run.url);
	const proxied = await answer(() => activeFrame(page), run.run);
	console.log(mode, JSON.stringify(proxied));
	ok(
		`${mode}: the server reads every byte, over about the link time`,
		proxied?.counted === TOTAL && proxied.ms >= linkMs * 0.8,
		JSON.stringify({ native, proxied }),
	);
	const name = `${mode}: what the page's writes settled at each mark is no more than natively and Chrome's buffer`;
	const paced =
		Array.isArray(proxied?.at) &&
		MARKS.every((_, i) => {
			const n = native?.at?.[i];
			const p = proxied.at[i];
			// (a mark after the upload was done)
			if (typeof n !== 'number' || typeof p !== 'number') return true;
			return p <= n + SLACK;
		});
	const detail = JSON.stringify({ native: native?.at, proxied: proxied?.at });
	// a stomp-h3 built before its writes waited for the datagrams settles
	// them as quinn takes the bytes (webtransport-env.mjs): known until the
	// epoxy-transport STomp pins has the build, an error once it passes
	if (!writesSettleAsSent && !paced)
		console.log(`KNOWN ${name} (${STOMP_H3} settles writes early) - ${detail}`);
	else
		ok(
			writesSettleAsSent ? name : `${name}: passes, so the KNOWN entry goes`,
			writesSettleAsSent && paced,
			detail,
		);
	await page.close();
}

await done(browser);
server.close?.();
