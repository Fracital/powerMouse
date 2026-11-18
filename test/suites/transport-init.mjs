// A transport served on several ports is initialised once, however many
// ports and requests find it not ready at the same time: init() is not
// idempotent everywhere (epoxy's loaded its wasm again per call, and two
// same-tick calls killed the first client). Node-side: serveTransport and
// RemoteTransport bundled from src, a fake transport counting init() calls,
// two ports, requests fired in one tick. A failed init is retried.
// warmTransport (src/transport/worker.ts calls it once a transport is made)
// loads it and opens epoxy's wisp connection before any request, once, and a
// request that comes meanwhile waits for both. Given epoxy's ECH resolver,
// it then opens that connection too, with one query of the resolver's own
// name on epoxy's own transport, under the wrappers.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP transport-init: esbuild is not installed');
	process.exit(0);
}

const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}transport-init-entry.mjs`;
writeFileSync(
	entry,
	`export * as served from ${JSON.stringify(`${root}src/transport/serveTransport.ts`)};
export { default as RemoteTransport } from ${JSON.stringify(`${root}src/transport/RemoteTransport.ts`)};
`,
);
const bundle = `${OUT}transport-init.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: bundle,
	logLevel: 'silent',
});
const { served, RemoteTransport } = await import(`${bundle}?${Date.now()}`);
const { default: serveTransport, warmTransport } = served;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fake = ({ failFirst = false } = {}) => ({
	ready: false,
	inits: 0,
	async init() {
		this.inits++;
		await sleep(50);
		if (failFirst && this.inits === 1) throw new Error('first init fails');
		this.ready = true;
	},
	async request() {
		return { body: null, headers: [], status: 200, statusText: 'OK' };
	},
	connect() {
		return [() => {}, () => {}];
	},
	meta() {
		return {};
	},
});
const remote = (transport) => {
	const { port1, port2 } = new MessageChannel();
	serveTransport(port1, () => transport);
	const client = new RemoteTransport(port2);
	return { client, close: () => (port1.close(), port2.close()) };
};
const fire = (clients) =>
	Promise.all(
		clients.flatMap((client) =>
			[1, 2, 3].map(() =>
				client
					.init()
					.then(() =>
						client.request(new URL('https://example.com/'), 'GET', null, {}),
					)
					.then(
						(response) => response.status,
						(error) => `rejected ${error.message}`,
					),
			),
		),
	);

{
	const transport = fake();
	const ports = [remote(transport), remote(transport)];
	const statuses = await fire(ports.map((p) => p.client));
	ok(
		'six same-tick requests over two ports initialise the transport once',
		transport.inits === 1 && statuses.every((status) => status === 200),
		JSON.stringify({ inits: transport.inits, statuses }),
	);
	ports.forEach((p) => p.close());
}
{
	const transport = fake({ failFirst: true });
	const ports = [remote(transport)];
	const first = await fire([ports[0].client]);
	const second = await fire([ports[0].client]);
	ok(
		'a failed init is not kept: the next request initialises again and succeeds',
		transport.inits === 2 &&
			first.every((status) => /first init fails/.test(String(status))) &&
			second.every((status) => status === 200),
		JSON.stringify({ inits: transport.inits, first, second }),
	);
	ports.forEach((p) => p.close());
}
{
	// epoxy's client under a wrapper, as Http3Transport and RevivingTransport keep it
	const events = [];
	const epoxy = fake();
	const init = epoxy.init;
	epoxy.init = async function () {
		events.push('init');
		await init.call(this);
	};
	epoxy.client = {
		connects: 0,
		async replace_stream_provider() {
			this.connects++;
			events.push('connect');
			await sleep(50);
			events.push('connected');
		},
	};
	const request = epoxy.request;
	epoxy.request = async function (...args) {
		events.push('request');
		return request.apply(this, args);
	};
	const wrapper = {
		base: epoxy,
		get ready() {
			return epoxy.ready;
		},
		init: () => epoxy.init(),
		request: (...args) => epoxy.request(...args),
		connect: (...args) => epoxy.connect(...args),
		meta: () => ({}),
	};
	const warmed = typeof warmTransport === 'function';
	if (warmed) warmTransport(wrapper);
	const ports = [remote(wrapper), remote(wrapper)];
	// fired while init and the connection are under way
	await sleep(10);
	const statuses = await fire(ports.map((p) => p.client));
	ok(
		'a warmed transport is initialised and connected once, before any request, and requests that come meanwhile wait for the connection',
		warmed &&
			epoxy.inits === 1 &&
			epoxy.client.connects === 1 &&
			events.indexOf('connected') !== -1 &&
			events.indexOf('connected') < events.indexOf('request') &&
			statuses.every((status) => status === 200),
		JSON.stringify({
			warmed,
			inits: epoxy.inits,
			connects: epoxy.client.connects,
			events: [...new Set(events)],
			statuses,
		}),
	);
	ports.forEach((p) => p.close());
}
{
	const transport = fake({ failFirst: true });
	transport.client = {
		async replace_stream_provider() {
			throw new Error('never reached');
		},
	};
	const warmed = typeof warmTransport === 'function';
	if (warmed) warmTransport(transport);
	await sleep(100);
	const ports = [remote(transport)];
	const statuses = await fire([ports[0].client]);
	ok(
		'a warm that fails to load the transport is not kept: the first request initialises it again and succeeds',
		warmed &&
			transport.inits === 2 &&
			statuses.every((status) => status === 200),
		JSON.stringify({ warmed, inits: transport.inits, statuses }),
	);
	ports.forEach((p) => p.close());
}
{
	const transport = fake();
	transport.client = {
		async replace_stream_provider() {
			await sleep(20);
			throw new Error('wisp server unreachable');
		},
	};
	const warmed = typeof warmTransport === 'function';
	if (warmed) warmTransport(transport);
	const ports = [remote(transport)];
	const statuses = await fire([ports[0].client]);
	ok(
		'a connection the warm cannot open leaves the loaded transport to its first request',
		warmed &&
			transport.inits === 1 &&
			statuses.every((status) => status === 200),
		JSON.stringify({ warmed, inits: transport.inits, statuses }),
	);
	ports.forEach((p) => p.close());
}
{
	const epoxy = fake();
	const asked = [];
	epoxy.request = async (url, method, body, headers) => {
		asked.push({ url: String(url), method, headers });
		return { body: null, headers: [], status: 200, statusText: 'OK' };
	};
	const wrapper = {
		base: epoxy,
		get ready() {
			return epoxy.ready;
		},
		init: () => epoxy.init(),
		request: () => {
			throw new Error('the wrapper was asked');
		},
		connect: () => [() => {}, () => {}],
		meta: () => ({}),
	};
	const warmed = typeof warmTransport === 'function';
	if (warmed) warmTransport(wrapper, 'https://resolver.example/dns-query');
	await sleep(150);
	const query = asked[0] && new URL(asked[0].url);
	ok(
		"a warm given epoxy's ECH resolver asks it once for its own name, on epoxy's own transport, as a DNS message",
		warmed &&
			asked.length === 1 &&
			asked[0].method === 'GET' &&
			query.origin === 'https://resolver.example' &&
			query.pathname === '/dns-query' &&
			/^[A-Za-z0-9_-]+$/.test(query.searchParams.get('dns') ?? '') &&
			JSON.stringify(asked[0].headers) ===
				JSON.stringify([['accept', 'application/dns-message']]),
		JSON.stringify({ warmed, asked }),
	);
}
await done();
