// A transport served on several ports is initialised once, however many
// ports and requests find it not ready at the same time: init() is not
// idempotent everywhere (epoxy's loaded its wasm again per call, and two
// same-tick calls killed the first client). Node-side: serveTransport and
// RemoteTransport bundled from src, a fake transport counting init() calls,
// two ports, requests fired in one tick. A failed init is retried.
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
	`export { default as serveTransport } from ${JSON.stringify(`${root}src/transport/serveTransport.ts`)};
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
const { serveTransport, RemoteTransport } = await import(
	`${bundle}?${Date.now()}`
);

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
await done();
