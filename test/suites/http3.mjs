// HTTP/3 on real sites (needs the internet; SKIP_NETWORK=1 leaves it out).
// A controller whose epoxy descriptor has `http3: true` loads
// https://quic.nginx.org/ over HTTP/2, learns its Alt-Svc, connects QUIC
// over the demo server's wisp UDP in the background, and the page's own
// check (an XHR to /test three seconds in, which reads the X-QUIC header
// nginx sets from $http3) reports h3. Through a wisp server that refuses
// UDP the same page loads as fast and reports that it is not on QUIC.
// Raw requests through an Http3Transport instance check the rest: Cloudflare
// and Google over h3, a gzip body decoded, a response header block over
// 16 KiB (YouTube to a HeadlessChrome UA, the epoxy h2 limit fixed in
// deploy/epoxy), a request body, a streamed request body, and the time a
// request takes over h3 against h2. Needs stomp-h3 in the epoxy build
// (deploy/epoxy/h3); without it the suite says so and fails.
import { createServer } from 'node:http';
import { holyWisp } from 'holywisp';
import { done, launch, ok, PROXY } from '../lib.mjs';

const EPOXY = '/epoxy/index.mjs';
const H3 = '/epoxy/h3/stomp_h3.js';
const DEMO_WISP = PROXY.replace(/^http/, 'ws') + 'wisp/';

// a wisp server of this suite's own that refuses UDP, as a holyWisp edge
// with `allow-udp = off` does (it stops with this process)
const wisp = await new holyWisp({
	port: 0,
	allowUDP: false,
	floodProtection: { enabled: false },
	logLevel: 'error',
}).start(1);
const noUdp = createServer((req, res) => res.end());
noUdp.on('upgrade', (req, socket, head) => wisp.route(req, socket, head));
await new Promise((resolve) => noUdp.listen(0, '127.0.0.1', resolve));
const NO_UDP_WISP = `ws://127.0.0.1:${noUdp.address().port}/`;

const browser = await launch();
const errors = [];

async function page() {
	const context = await browser.newContext();
	const p = await context.newPage();
	p.on('pageerror', (error) => errors.push(error.message));
	await p.goto(`${PROXY}stomp/controllerFrame.html`);
	return { p, close: () => context.close() };
}

const present = await (async () => {
	const { p, close } = await page();
	const status = await p.evaluate(
		async (url) => (await fetch(url, { method: 'HEAD' })).status,
		H3,
	);
	await close();
	return status === 200;
})();
ok(
	'stomp-h3 ships with the epoxy build (/epoxy/h3/stomp_h3.js)',
	present,
	'rebuild epoxy with deploy/epoxy/build.sh',
);

/** quic.nginx.org in a proxied frame; what its own check said, and when */
const nginxCheck = async ({ module, wisp: wispUrl }) => {
	const { StompController } = await import('/stomp/controller.mjs');
	const registration = await StompController.register('/stomp/');
	const controller = new StompController({
		serviceworker: registration,
		transport: { module, options: [{ wisp: wispUrl }], http3: true },
		directory: '/stomp/',
		codec: 'xor',
		// without the content blocker: one of the two wisp servers is this
		// suite's own, which does not refuse the list servers as the run's
		// does (test/run.mjs), and what the lists would cost in HTTP/3
		// attempts is not what is read here
		adblock: false,
	});
	await controller.wait();
	const element = document.createElement('iframe');
	document.body.append(element);
	const frame = controller.createFrame(element);
	const t0 = performance.now();
	await frame.go('https://quic.nginx.org/');
	const loaded = Math.round(performance.now() - t0);
	const deadline = performance.now() + 20000;
	for (;;) {
		const doc = element.contentDocument;
		const shown = (selector) => {
			const node = doc?.querySelector(selector);
			return !!node && !node.classList.contains('hidden');
		};
		if (shown('.quic-support__text_success'))
			return { verdict: 'h3', loaded, at: Math.round(performance.now() - t0) };
		if (shown('.quic-support__text_fail'))
			return {
				verdict: 'not h3',
				loaded,
				at: Math.round(performance.now() - t0),
			};
		if (performance.now() > deadline)
			return { verdict: 'no answer', loaded, title: doc?.title };
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
};

{
	const { p, close } = await page();
	const result = await p
		.evaluate(nginxCheck, { module: EPOXY, wisp: DEMO_WISP })
		.catch((error) => ({ error: String(error).slice(0, 300) }));
	ok(
		'quic.nginx.org reports h3 through the proxy (http3: true, wisp with UDP)',
		result.verdict === 'h3',
		JSON.stringify(result),
	);
	await close();
}

{
	const { p, close } = await page();
	const result = await p
		.evaluate(nginxCheck, { module: EPOXY, wisp: NO_UDP_WISP })
		.catch((error) => ({ error: String(error).slice(0, 300) }));
	ok(
		'through a wisp server that refuses UDP, quic.nginx.org loads and reports not h3',
		result.verdict === 'not h3',
		JSON.stringify(result),
	);
	// the page's check fires 3 s after load; one more round trip after that
	ok(
		'and nothing stalls: the page loads and its check answers on time',
		result.loaded < 10000 && result.at < result.loaded + 6000,
		JSON.stringify(result),
	);
	await close();
}

/** raw requests through an Http3Transport instance around epoxy */
const raw = async ({ module, h3, wisp: wispUrl, plan, options = {} }) => {
	const { Http3Transport } = await import('/stomp/controller.mjs');
	const { default: Epoxy } = await import(module);
	const transport = new Http3Transport(
		new Epoxy({ wisp: wispUrl }),
		options,
		h3,
	);
	await transport.init();
	const results = [];
	const run = async ({ url, method = 'GET', body = null, headers = [] }) => {
		let sent = body;
		if (body === 'stream') {
			const chunks = [
				new TextEncoder().encode('a=1&'),
				new TextEncoder().encode('b=2'),
			];
			sent = new ReadableStream({
				pull(controller) {
					const next = chunks.shift();
					if (next) controller.enqueue(next);
					else controller.close();
				},
			});
		}
		const t0 = performance.now();
		const response = await transport.request(
			new URL(url),
			method,
			sent,
			headers,
			undefined,
		);
		const head = Math.round(performance.now() - t0);
		const text = response.body ? await new Response(response.body).text() : '';
		let form;
		try {
			form = JSON.parse(text).form;
		} catch {
			// not JSON
		}
		const via = transport.info().recent.at(-1)?.via;
		return {
			url,
			via,
			status: response.status,
			head,
			ms: Math.round(performance.now() - t0),
			length: text.length,
			tail: text.slice(-40),
			trace: /^http=.*$/m.exec(text)?.[0],
			form,
			headerBytes: response.headers.reduce(
				(n, [k, v]) => n + k.length + v.length + 4,
				0,
			),
			quic: response.headers.find(([k]) => k.toLowerCase() === 'x-quic')?.[1],
		};
	};
	for (const step of plan) {
		if (step.wait) {
			// until the background QUIC connection to the origin is up
			const deadline = performance.now() + step.wait;
			while (
				performance.now() < deadline &&
				!transport
					.info()
					.connections.some((c) => c.origin === step.origin && c.alive)
			)
				await new Promise((resolve) => setTimeout(resolve, 50));
			continue;
		}
		try {
			results.push(await run(step));
		} catch (error) {
			results.push({ url: step.url, error: String(error).slice(0, 200) });
		}
	}
	return { results, info: transport.info() };
};

// `path` is asked three times: over h2 (cold), then twice over h3 once the
// connection the Alt-Svc of `learn` (default: that same response) started
// is up. Cloudflare's /cdn-cgi/trace sends no Alt-Svc; its home page does.
const FORM = [['content-type', 'application/x-www-form-urlencoded']];
const sites = [
	{ origin: 'https://quic.nginx.org', path: '/test' },
	{ origin: 'https://cloudflare-quic.com', path: '/cdn-cgi/trace', learn: '/' },
	{ origin: 'https://www.google.com', path: '/' },
];
{
	const { p, close } = await page();
	const plan = [];
	for (const { origin, path, learn } of sites) {
		plan.push({ url: origin + path });
		if (learn) plan.push({ url: origin + learn });
		plan.push({ wait: 10000, origin });
		plan.push({ url: origin + path }, { url: origin + path });
	}
	plan.push(
		{ url: 'https://www.youtube.com/' },
		{ wait: 10000, origin: 'https://www.youtube.com' },
		{ url: 'https://www.youtube.com/' },
		// pie.dev is httpbin behind Cloudflare: it echoes the form it got
		{ url: 'https://pie.dev/get' },
		{ wait: 10000, origin: 'https://pie.dev' },
		{
			url: 'https://pie.dev/post',
			method: 'POST',
			body: 'a=1&b=2',
			headers: FORM,
		},
		{
			url: 'https://pie.dev/post',
			method: 'POST',
			body: 'stream',
			headers: FORM,
		},
	);
	const { results, info } = await p
		.evaluate(raw, { module: EPOXY, h3: H3, wisp: DEMO_WISP, plan })
		.catch((error) => ({ results: [], info: String(error).slice(0, 300) }));
	const at = (url, n) => results.filter((r) => r.url === url)[n] || {};
	const nginx = sites[0].origin + sites[0].path;
	const cf = sites[1].origin + sites[1].path;
	const google = sites[2].origin + sites[2].path;
	ok(
		'quic.nginx.org: the first request goes over h2 and teaches the Alt-Svc',
		at(nginx, 0).via === 'base' && at(nginx, 0).quic !== 'h3',
		JSON.stringify(at(nginx, 0)),
	);
	ok(
		'quic.nginx.org: the next ones go over h3 and nginx says so (X-QUIC: h3)',
		at(nginx, 1).via === 'h3' &&
			at(nginx, 1).quic === 'h3' &&
			at(nginx, 2).quic === 'h3',
		JSON.stringify([at(nginx, 1), at(nginx, 2)]),
	);
	ok(
		'cloudflare-quic.com: its trace says http/3 after the Alt-Svc, http/2 before',
		at(cf, 0).trace === 'http=http/2' &&
			at(cf, 1).trace === 'http=http/3' &&
			at(cf, 1).via === 'h3',
		JSON.stringify([at(cf, 0), at(cf, 1)]),
	);
	ok(
		'www.google.com over h3: 200, the gzip body decoded whole',
		at(google, 1).via === 'h3' &&
			at(google, 1).status === 200 &&
			at(google, 1).length > 50000 &&
			/<\/html>\s*$/i.test(at(google, 1).tail),
		JSON.stringify(at(google, 1)),
	);
	const yt = results.filter((r) => r.url === 'https://www.youtube.com/');
	ok(
		'www.youtube.com: a response header block over 16 KiB arrives over h2 and over h3',
		yt.length === 2 &&
			yt[0].via === 'base' &&
			yt[1].via === 'h3' &&
			yt.every((r) => r.status === 200 && r.headerBytes > 16384),
		JSON.stringify(
			yt.map(({ via, status, headerBytes }) => ({ via, status, headerBytes })),
		),
	);
	const posts = results.filter((r) => r.url === 'https://pie.dev/post');
	ok(
		'a request body and a streamed request body go up over h3 whole (pie.dev echoes the form)',
		posts.length === 2 &&
			posts.every(
				(r) =>
					r.via === 'h3' &&
					r.status === 200 &&
					r.form?.a === '1' &&
					r.form?.b === '2',
			),
		JSON.stringify(
			posts.map(({ via, status, form, error }) => ({
				via,
				status,
				form,
				error,
			})),
		),
	);
	// timings: the first (h2, cold connection) against h3 on a warm connection
	const timing = sites.map(({ origin, path }) => {
		const url = origin + path;
		return {
			origin,
			h2: at(url, 0).head,
			h3: [at(url, 1).head, at(url, 2).head],
		};
	});
	console.log('timings (ms to response head):', JSON.stringify(timing));
	console.log('connections:', JSON.stringify(info.connections ?? info));
	await close();
}

// an HTTPS record instead of an Alt-Svc: Cloudflare's /cdn-cgi/trace never
// sends one, but cloudflare-quic.com's record (alpn h3,h2) names h3
{
	const { p, close } = await page();
	const url = 'https://cloudflare-quic.com/cdn-cgi/trace';
	const { results, info } = await p
		.evaluate(raw, {
			module: EPOXY,
			h3: H3,
			wisp: DEMO_WISP,
			options: { dns: 'https://cloudflare-dns.com/dns-query' },
			plan: [
				{ url },
				{ wait: 10000, origin: 'https://cloudflare-quic.com' },
				{ url },
			],
		})
		.catch((error) => ({ results: [], info: String(error).slice(0, 300) }));
	const entry = info.altSvc?.find(
		(e) => e.origin === 'https://cloudflare-quic.com',
	);
	ok(
		'an HTTPS DNS record (dns option) is enough: the trace goes over h3 with no Alt-Svc seen',
		results[0]?.trace === 'http=http/2' &&
			results[1]?.trace === 'http=http/3' &&
			entry?.source === 'dns',
		JSON.stringify({ results, entry }),
	);
	await close();
}

noUdp.close();
await done(browser, errors);
