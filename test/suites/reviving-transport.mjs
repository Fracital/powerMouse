// RevivingTransport retries a request whose wisp stream was refused before it
// went out, instead of surfacing the failure to the page. A wisp server
// throttling a burst (holyWisp refuses the streams past a connection's cap, so
// epoxy's TLS over such a stream ends with "tls handshake eof" inside an
// Error(Connect, ...)) used to fail a whole challenge's worth of concurrent
// POSTs at once. The request never went out, so it is safe to send again on the
// same live connection once the streams ahead of it finish; a short growing
// backoff spaces the retries. A connection truly lost (MuxTaskEnded) still
// builds a new transport. Node-side: RevivingTransport bundled from src, a fake
// transport scripted to fail a set number of times.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch {
	console.log('SKIP reviving-transport: esbuild is not installed');
	process.exit(0);
}

const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}reviving-transport-entry.mjs`;
writeFileSync(
	entry,
	`export { default as RevivingTransport } from ${JSON.stringify(`${root}src/transport/RevivingTransport.ts`)};\n`,
);
const bundle = `${OUT}reviving-transport.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: bundle,
	logLevel: 'silent',
});
const { RevivingTransport } = await import(`${bundle}?${Date.now()}`);

// the error epoxy reports for a stream refused before the request went out: a
// throttled stream (holyWisp per_ws_streams), measured against the real server
const CONNECT_REFUSED =
	'Hyper client: hyper_util::client::legacy::Error(Connect, Io(Custom { kind: UnexpectedEof, error: "tls handshake eof" }))';
const MUX_ENDED =
	'Hyper client: hyper_util::client::legacy::Error(Connect, Wisp(MuxTaskEnded) (Multiplexor task ended))';

const response = () => ({
	body: null,
	headers: [],
	status: 200,
	statusText: 'OK',
});

// A fake ProxyTransport. `plan(call)` returns an Error to throw for that request
// (1-based per this transport instance) or null to answer 200. `builds` counts
// how many transports were made (RevivingTransport builds a new one on revive).
function makeFactory(plan) {
	let builds = 0;
	const factory = () => {
		builds++;
		let calls = 0;
		return {
			ready: true,
			async init() {
				this.ready = true;
			},
			async request() {
				const error = plan(++calls);
				if (error) throw error;
				return response();
			},
			connect() {
				return [() => {}, () => {}];
			},
		};
	};
	return { factory, builds: () => builds };
}

// 1) a GET refused at connect twice, then served: it answers, on the same
// transport (no new one built), and the backoff made it take a moment
{
	const { factory, builds } = makeFactory((call) =>
		call <= 2 ? new Error(CONNECT_REFUSED) : null,
	);
	const transport = new RevivingTransport(factory);
	const t0 = Date.now();
	const r = await transport
		.request(new URL('https://example.com/'), 'GET', null, [], undefined)
		.then(
			(res) => res.status,
			(error) => `rejected ${error.message}`,
		);
	const elapsed = Date.now() - t0;
	ok(
		'a GET refused at connect is retried on the same connection and answers',
		r === 200 && builds() === 1,
		JSON.stringify({ status: r, builds: builds(), elapsed }),
	);
	ok(
		'the retries were spaced by a backoff, not fired at once',
		elapsed >= 50,
		`${elapsed}ms`,
	);
}

// 2) a POST with a resendable body refused at connect once, then served: it is
// retried too (the body never went out, so sending it again is safe)
{
	const { factory, builds } = makeFactory((call) =>
		call <= 1 ? new Error(CONNECT_REFUSED) : null,
	);
	const transport = new RevivingTransport(factory);
	const r = await transport
		.request(
			new URL('https://example.com/challenge'),
			'POST',
			'turnstile-token-body',
			[['content-type', 'text/plain']],
			undefined,
		)
		.then(
			(res) => res.status,
			(error) => `rejected ${error.message}`,
		);
	ok(
		'a POST with a resendable body refused at connect is retried and answers',
		r === 200 && builds() === 1,
		JSON.stringify({ status: r, builds: builds() }),
	);
}

// 3) a burst of concurrent requests, each refused twice (a throttled server
// turning away the streams past its cap) before it is let through: all of them
// complete rather than surfacing the refusal to the page. The fake is scripted
// with its own per-request attempt count so the test does not race.
{
	const attempts = new Map();
	const factory = () => ({
		ready: true,
		async init() {},
		async request(remote) {
			const n = (attempts.get(remote.href) ?? 0) + 1;
			attempts.set(remote.href, n);
			if (n <= 2) throw new Error(CONNECT_REFUSED);
			return response();
		},
		connect() {
			return [() => {}, () => {}];
		},
	});
	const transport = new RevivingTransport(factory);
	const results = await Promise.all(
		Array.from({ length: 40 }, (_, i) =>
			transport
				.request(
					new URL(`https://example.com/x${i}`),
					'GET',
					null,
					[],
					undefined,
				)
				.then(
					(res) => res.status,
					(error) => `rejected ${error.message}`,
				),
		),
	);
	ok(
		'a burst throttled past the per-connection cap all answers, none surfaces the refusal',
		results.every((r) => r === 200),
		JSON.stringify({
			ok: results.filter((r) => r === 200).length,
			of: results.length,
		}),
	);
}

// 4) a request that reports the wisp connection gone (MuxTaskEnded) builds a new
// transport and answers on it
{
	let builtCount = 0;
	let failed = false;
	const builds = () => builtCount;
	const factory = () => {
		builtCount++;
		return {
			ready: true,
			async init() {},
			async request() {
				// the lost connection reports the mux ended once; the new one serves
				if (!failed) {
					failed = true;
					throw new Error(MUX_ENDED);
				}
				return response();
			},
			connect() {
				return [() => {}, () => {}];
			},
		};
	};
	const transport = new RevivingTransport(factory);
	const r = await transport
		.request(new URL('https://example.com/'), 'GET', null, [], undefined)
		.then(
			(res) => res.status,
			(error) => `rejected ${error.message}`,
		);
	ok(
		'a request on a lost connection answers over a newly built transport',
		r === 200 && builds() === 2,
		JSON.stringify({ status: r, builds: builds() }),
	);
}

// 5) an error that is neither a lost connection nor a connect-phase refusal is
// not retried: it is the page's, at once
{
	let calls = 0;
	const { factory } = makeFactory(() => {
		calls++;
		return new Error('HTTP 500 from the origin, already answered');
	});
	const transport = new RevivingTransport(factory);
	const r = await transport
		.request(new URL('https://example.com/'), 'GET', null, [], undefined)
		.then(
			(res) => res.status,
			(error) => `rejected ${error.message}`,
		);
	ok(
		'a genuine response error is not retried, it surfaces at once',
		/rejected/.test(String(r)) && calls === 1,
		JSON.stringify({ result: r, calls }),
	);
}

await done();
