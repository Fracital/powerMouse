import {
	CONTROLLER_INIT,
	CONTROLLER_RPC,
	Controllerbound,
	ControllerInitMessage,
	INIT_REMOTE_TRANSPORT,
	InitRemoteTransportMessage,
	postToPort,
	SW_REVIVE,
	SWbound,
} from '../transport/messages';
import RemoteTransport from '../transport/RemoteTransport';
import { RpcHelper } from '../transport/rpc';
import { BUILD } from '../version';
import createServer, { StompServer } from './createServer';

interface ControllerRef {
	directory: string;
	port: MessagePort;
	rpc: RpcHelper<SWbound, Controllerbound>;
	server: Promise<StompServer>;
	ready?: StompServer;
}

/** one controller per directory (scope) */
const controllers = new Map<string, ControllerRef>();

function registerController(
	{ directory, config }: ControllerInitMessage,
	port: MessagePort,
) {
	const existing = controllers.get(directory);

	if (existing) {
		existing.rpc.abort('Controller replaced');
		existing.port.close();
	}

	const transport = new RemoteTransport(port);
	const server = createServer(config, transport);

	const rpc = new RpcHelper<SWbound, Controllerbound>(
		{
			route: async (url) => [(await server).route(url), []],
			clearCache: async () => {
				await (await server).clearCache();
			},
			cookies: async (command) => {
				const { cookies } = await server;
				switch (command.op) {
					case 'get':
						return [(await cookies.get(command.url)).toString(), []];
					case 'set':
						await cookies.set(command.setCookie, command.url);
						return [undefined, []];
					case 'list':
						return [await cookies.list(command.origin), []];
					case 'clear':
						await cookies.clear(command.origin);
						return [undefined, []];
				}
			},
		},
		CONTROLLER_RPC,
		(data, transfer) => postToPort(port, data, transfer),
	);

	port.addEventListener('message', (event) => rpc.receive(event.data));
	port.start();

	const ref: ControllerRef = { directory, port, rpc, server };
	server.then((ready) => (ref.ready = ready));
	controllers.set(directory, ref);

	server.then(
		() => rpc.call('ready', { build: BUILD }),
		(error) => console.error('Stomp: failed to create server', error),
	);
}

function controllerFor(pathname: string): ControllerRef | undefined {
	let match: ControllerRef | undefined;

	for (const ref of controllers.values())
		if (
			pathname.startsWith(ref.directory) &&
			(!match || ref.directory.length > match.directory.length)
		)
			match = ref;

	return match;
}

self.addEventListener('message', (event: ExtendableMessageEvent) => {
	const { data } = event;
	if (typeof data !== 'object' || data === null) return;

	if (CONTROLLER_INIT in data) {
		registerController(data[CONTROLLER_INIT], event.ports[0]);
	} else if (INIT_REMOTE_TRANSPORT in data) {
		const { directory } = data[
			INIT_REMOTE_TRANSPORT
		] as InitRemoteTransportMessage;
		const ref = controllers.get(directory);

		if (!ref) {
			console.error(`Stomp: no controller registered for ${directory}`);
			return;
		}

		const [port] = event.ports;
		ref.rpc.call('initRemoteTransport', port, [port]);
	}
});

self.addEventListener('fetch', (event: FetchEvent) => {
	const { pathname } = new URL(event.request.url);
	const ref = controllerFor(pathname);
	if (!ref) return;

	if (ref.ready) {
		if (ref.ready.router.willRoute(event.request.url))
			event.respondWith(ref.ready.router.route(event.request));
	} else {
		// the server is still opening its databases; decide once it's up
		event.respondWith(
			ref.server.then(({ router }) =>
				router.willRoute(event.request.url)
					? router.route(event.request)
					: fetch(event.request),
			),
		);
	}
});

self.addEventListener('install', () => {
	self.skipWaiting();
});

self.addEventListener('activate', (event: ExtendableEvent) => {
	event.waitUntil(self.clients.claim());
});

// This script only runs again when the worker was terminated and restarted.
// Nothing in `controllers` survived, so ask every client to re-register.
setTimeout(async () => {
	for (const client of await self.clients.matchAll({
		includeUncontrolled: true,
	}))
		client.postMessage({ [SW_REVIVE]: {} });
}, 100);
