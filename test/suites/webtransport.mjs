// WebTransport through the proxy (docs/webtransport.md). The browser's own
// WebTransport sends QUIC from the network service, from the user's
// address, to the server a page names, past everything the proxy does: a
// proxied page that constructed one reached the server natively. So no
// realm of a proxied page has the browser's constructor: `WebTransport` is
// a stand-in, whose sessions the transport carries (QUIC on a wisp UDP
// stream; their streams and datagrams are webtransport-live's), and this
// suite holds it to two things.
//
// Nothing leaves natively. A UDP socket of the suite's hears every
// datagram sent to it and never answers. Natively a session to it is a
// QUIC handshake it hears (the control, checked first for every way: a way
// the browser itself has no WebTransport for is no way). Through the proxy
// what it hears is the demo's wisp server's (test/sockets.mjs tells whose
// socket sent each datagram), never the browser's, whichever way the page
// reaches a constructor: `new`,
// Reflect.construct with and without a new.target, the prototype's
// `constructor`, another session's, a subclass, a bound function; in the
// page, in a dedicated, a module, a blob, a nested, a shared and a service
// worker; in a frame's first window read before anything loaded, an
// about:blank frame, a loaded one, a popup, and in documents that run the
// session themselves (srcdoc, sandboxed, blob:, data:, document.write,
// javascript:, a page of the same origin and one of another).
//
// And it reads as the browser's. The same page runs natively and proxied
// (both demo modes), in the page and in workers, and every answer is
// compared: the constructor's and the prototypes' shapes before and after
// a session was made, what the constructor says to some eighty arguments
// and in which order it reads its options, how a session to a server that
// cannot be reached ends (a closed port, a name that does not resolve, a
// pinned certificate; which promise rejects first, with what, and what the
// streams and createBidirectionalStream answer before, during and after),
// close() while connecting, the datagram numbers and what they take, the
// members on something that is no session, the page's own
// WebTransportError, unhandled rejections, Chrome's throttle of a page's
// handshakes, and a session the page's own connect-src refuses.
import { createSocket } from 'node:dgram';
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
	submitOmni,
} from '../lib.mjs';
import { tally, watchSockets } from '../sockets.mjs';
import {
	webTransportClient,
	wispReportsRefusal,
} from '../webtransport-env.mjs';

const sockets = await watchSockets();

const bound = (socket) =>
	new Promise((resolve) => socket.bind(0, '127.0.0.1', () => resolve(socket)));
// a UDP port nothing listens on: taken, then let go
const closedPort = await (async () => {
	const socket = await bound(createSocket('udp4'));
	const { port } = socket.address();
	await new Promise((resolve) => socket.close(resolve));
	return port;
})();
/** a UDP port that hears and never answers */
async function hearing() {
	const socket = await bound(createSocket('udp4'));
	const heard = { port: socket.address().port, packets: [], socket };
	socket.on('message', (message, from) =>
		heard.packets.push(sockets.arrival(from.port)),
	);
	return heard;
}

let runs = 0;
/** the URL of one run of `file`, and the port that hears for it */
async function run(file, query) {
	const heard = await hearing();
	const id = `r${++runs}`;
	const search = new URLSearchParams({
		...query,
		run: id,
		closed: closedPort,
		silent: heard.port,
	});
	return { id, heard, url: `${FIXTURE}pages/${file}?${search}` };
}
async function answer(frame, id, timeout = 45000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const target = await frame();
		const value = await target
			?.evaluate((run) => (window.__wt?.run === run ? window.__wt : null), id)
			.catch(() => null);
		if (value) return value.result;
		await sleep(150);
	}
	return { probeError: 'the page never answered' };
}
async function finish({ heard }, result) {
	// what was sent while the page answered has arrived by now
	await sleep(100);
	heard.socket.close();
	const senders = sockets.senders(heard.packets);
	return {
		result,
		heard: senders.length,
		browser: senders.filter((who) => who === 'browser').length,
		senders: tally(senders),
	};
}

const browser = await launch();

// a stomp-h3 without a WebTransport client (one released before it had one)
// leaves the stand-in alone: its sessions fail as ones whose server cannot
// be reached, and nothing leaves at all
if (!webTransportClient)
	console.log(
		'NOTE the stomp-h3 epoxy-transport ships has no WebTransport client: the stand-in is held to failing every session, with nothing sent',
	);
// a wisp server that reports a closed UDP port late makes a proxied session
// to one fail late: there, how such a session ends is compared, and when is
// listed (../webtransport-env.mjs)
const wisp = webTransportClient
	? await wispReportsRefusal(`${PROXY.replace(/^http/, 'ws')}wisp/`)
	: { prompt: true, ms: [] };
if (!wisp.prompt)
	console.log(
		`NOTE the wisp server reports a closed UDP port late (streams closed after ${wisp.ms.map((ms) => (ms === null ? 'never' : `${ms} ms`)).join(', ')}): sessions to a closed port are compared by how they end, not when`,
	);
/** how much later than natively a proxied session to a closed port may fail */
const LATER_MS = 50;

async function natively(file, query) {
	const made = await run(file, query);
	const page = await browser.newPage();
	await page.goto(made.url);
	const result = await answer(() => page.mainFrame(), made.id);
	await page.close();
	return finish(made, result);
}

/** a tab of the demo, navigated again for each run */
function proxiedTab(base) {
	let page = null;
	let chain = Promise.resolve();
	return (file, query) => {
		const next = chain.then(async () => {
			const made = await run(file, query);
			if (!page) {
				page = await openDemo(browser, base);
				await submitLanding(page, made.url);
			} else await submitOmni(page, made.url);
			return finish(made, await answer(() => activeFrame(page), made.id));
		});
		chain = next.catch(() => {});
		return next;
	};
}

const brief = (value) => {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return text === undefined
		? 'undefined'
		: text.length > 400
			? `${text.slice(0, 400)}...`
			: text;
};
/** where two answers differ, by the path to each difference */
function differences(native, proxied, path = '') {
	if (
		native !== null &&
		proxied !== null &&
		typeof native === 'object' &&
		typeof proxied === 'object' &&
		Array.isArray(native) === Array.isArray(proxied)
	) {
		const out = [];
		for (const key of new Set([
			...Object.keys(native),
			...Object.keys(proxied),
		]))
			out.push(
				...differences(
					native[key],
					proxied[key],
					path ? `${path}.${key}` : key,
				),
			);
		return out;
	}
	const [a, b] = [native, proxied].map((value) =>
		typeof value === 'string' ? value : (JSON.stringify(value) ?? 'undefined'),
	);
	if (a === b) return [];
	// two long answers: from where they part
	let at = 0;
	while (at < a.length && a[at] === b[at]) at++;
	const from = Math.max(0, at - 60);
	const part = (text) =>
		(from ? '...' : '') + brief(text.slice(from, from + 260));
	return [`${path}: native ${part(a)} proxied ${part(b)}`];
}

// ---- what is asked -----------------------------------------------------

const WORKERS = ['worker', 'sharedWorker', 'serviceWorker'];
/** [file, query, what it shows] */
const compared = [
	...[
		['shapes', 'the constructor and the prototypes'],
		['construct', "the constructor's answers to its arguments"],
		['members', "a session's members"],
		['closed', 'a session to a closed port'],
		['closedEarly', 'a session to a closed port, used while it connects'],
		['closedClose', 'close() while connecting'],
		['unresolvable', 'a session to a name that does not resolve'],
		['pinned', 'a pinned session to a closed port'],
		['throttle', 'seventy sessions at once'],
	].map(([name, what]) => ['webtransport.html', { case: name }, what]),
	...WORKERS.flatMap((realm) =>
		[
			['shapes', 'the constructor and the prototypes'],
			['construct', "the constructor's answers to its arguments"],
			['closed', 'a session to a closed port'],
			['closedClose', 'close() while connecting'],
		].map(([name, what]) => [
			'webtransport.html',
			{ case: name, realm },
			`${what}, in a ${realm}`,
		]),
	),
	['webtransport-csp.html', {}, "a session the page's connect-src refuses"],
	[
		'webtransport-csp-ro.html',
		{},
		"a session the page's report-only connect-src refuses",
	],
];
/** the ways to a constructor: [query, what] */
const reaches = [
	...[
		'new',
		'reflect',
		'newTarget',
		'prototype',
		'instance',
		'subclass',
		'bound',
		'functionApply',
	].map((how) => [{ how }, `the page, ${how}`]),
	...[
		'worker',
		'moduleWorker',
		'blobWorker',
		'nestedWorker',
		'sharedWorker',
		'serviceWorker',
		'freshFrame',
		'freshFrameWithSrc',
		'blankFrame',
		'loadedFrame',
		'popup',
		'srcdocFrame',
		'sandboxedFrame',
		'blobFrame',
		'dataFrame',
		'writtenFrame',
		'javascriptFrame',
		'pageFrame',
		'crossOriginFrame',
	].map((realm) => [{ realm }, `a ${realm}`]),
].map(([query, what]) => [{ case: 'reach', ...query }, what]);

// ---- natively ----------------------------------------------------------

/** `jobs` run `width` at a time, answers in order */
async function pool(jobs, width) {
	const out = [];
	let next = 0;
	await Promise.all(
		Array.from({ length: width }, async () => {
			while (next < jobs.length) {
				const index = next++;
				out[index] = await jobs[index]();
			}
		}),
	);
	return out;
}

const nativeCompared = await pool(
	compared.map(
		([file, query]) =>
			() =>
				natively(file, query),
	),
	4,
);
const nativeReaches = await pool(
	reaches.map(
		([query]) =>
			() =>
				natively('webtransport.html', query),
	),
	4,
);

compared.forEach(([, , what], index) => {
	const { result } = nativeCompared[index];
	ok(
		`natively, the page answered: ${what}`,
		result !== null && typeof result === 'object' && !result.probeError,
		brief(result),
	);
});
// a way the browser has no WebTransport for (or that this Chrome does not
// open) is noted and left out: there is nothing to keep in
const open = reaches.map(([, what], index) => {
	const { result, heard } = nativeReaches[index];
	const reached = heard > 0;
	console.log(
		`${reached ? 'PASS' : 'NOTE'} natively, a session from ${what} is a handshake the server hears${reached ? '' : ` - not here: ${brief(result)}, ${heard} datagrams`}`,
	);
	return reached;
});
ok(
	'natively, most of the ways reach the server',
	open.filter(Boolean).length >= reaches.length - 4,
	`${open.filter(Boolean).length} of ${reaches.length}`,
);

// ---- through the proxy -------------------------------------------------

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	// two tabs, each one run after another
	const tabs = [proxiedTab(base), proxiedTab(base)];
	let turn = 0;
	const proxied = (file, query) => tabs[turn++ % tabs.length](file, query);

	const reached = await Promise.all(
		reaches.map(([query]) => proxied('webtransport.html', query)),
	);
	reaches.forEach(([, what], index) => {
		const { result, heard, browser, senders } = reached[index];
		if (!open[index]) {
			// still nothing may leave natively (the proxy's realm there is a
			// secure context's, whose sessions the transport carries:
			// docs/webtransport.md)
			ok(
				`${mode}: a session from ${what} sends nothing natively (the browser has none there)`,
				browser === 0,
				`${senders}, ${brief(result)}`,
			);
			return;
		}
		if (!webTransportClient) {
			ok(
				`${mode}: a session from ${what} sends nothing`,
				heard === 0,
				`${senders} reached the server`,
			);
			ok(
				`${mode}: and ends as one whose server cannot be reached`,
				typeof result === 'string' &&
					result.startsWith('rejected') &&
					result.includes('WebTransportError') &&
					result.includes('Opening handshake failed.') &&
					result.includes('session'),
				brief(result),
			);
			return;
		}
		ok(
			`${mode}: a session from ${what} sends nothing natively`,
			browser === 0,
			`${senders} reached the server`,
		);
		if (reaches[index][0].realm === 'nestedWorker') {
			// a worker's worker has no transport (as for a WebSocket's;
			// docs/webtransport.md): its session never starts
			ok(
				`${mode}: known difference: a nested worker's session never reaches the server`,
				heard === 0,
				senders,
			);
			return;
		}
		ok(
			`${mode}: and reaches the server through the wisp server`,
			heard > 0 && senders === `${heard} server`,
			senders,
		);
		ok(
			`${mode}: and reads as natively, whose server never answers`,
			result === nativeReaches[index].result,
			`native ${brief(nativeReaches[index].result)} proxied ${brief(result)}`,
		);
	});

	const answers = await Promise.all(
		compared.map(([file, query]) => proxied(file, query)),
	);
	compared.forEach(([, , what], index) => {
		const native = { ...nativeCompared[index].result };
		const result = { ...answers[index].result };
		if ('cloned' in native) {
			// a session of the proxy's is an ordinary object on the browser's
			// prototype, which structuredClone copies where the browser's own
			// refuses (docs/webtransport.md): told here so that a build that
			// refuses it too says so
			ok(
				`${mode}: known difference: structuredClone copies a session (natively a DataCloneError)`,
				native.cloned.includes('DataCloneError') &&
					String(result.cloned).startsWith('ok'),
				`native ${native.cloned} proxied ${result.cloned}`,
			);
			delete native.cloned;
			delete result.cloned;
		}
		const [file, query] = compared[index];
		// when the session ended is told apart from how
		const nativeAfter = native.end?.after;
		const after = result.end?.after;
		for (const answer of [native, result])
			if (answer.end?.after !== undefined)
				answer.end = { ...answer.end, after: undefined };
		const late =
			!wisp.prompt &&
			(file === 'webtransport-csp-ro.html' ||
				['closed', 'closedEarly', 'pinned', 'throttle'].includes(query.case));
		if (late) {
			// how it ends, without what the page saw while it waited
			const ending = (answer) =>
				query.case === 'throttle'
					? { last: answer.last, lost: answer.lost }
					: file === 'webtransport-csp-ro.html'
						? {
								made: answer.made,
								both: answer.both,
								violations: answer.violations,
								end: answer.end,
							}
						: {
								end: answer.end,
								lateClose: answer.lateClose,
								lateCloseInfo: answer.lateCloseInfo,
								protocol: answer.protocol,
							};
			const differ = differences(ending(native), ending(result));
			ok(
				`${mode}: ${what}: ends as natively`,
				differ.length === 0,
				differ.slice(0, 12).join('\n     '),
			);
			console.log(
				`NOTE ${mode}: known difference: ${what}: ${after === undefined ? 'fails late' : `failed after ${after} ms, natively ${nativeAfter} ms`} (the wisp server reports the closed port late)`,
			);
			return;
		}
		if (after !== undefined && nativeAfter !== undefined)
			ok(
				`${mode}: ${what}: ends when natively`,
				after <= nativeAfter + LATER_MS,
				`after ${after} ms, natively ${nativeAfter} ms`,
			);
		const differ = differences(native, result);
		ok(
			`${mode}: ${what}: as natively`,
			differ.length === 0,
			differ.slice(0, 12).join('\n     ') +
				(differ.length > 12 ? `\n     and ${differ.length - 12} more` : ''),
		);
	});
}

console.log(`the server heard: ${await sockets.stop()}`);
await done(browser);
