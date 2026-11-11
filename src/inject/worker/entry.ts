import { helperNames } from '../../helperNames';
import {
	SW_PORT,
	TRANSPORT_INIT,
	WORKER_MODULES,
} from '../../transport/messages';
import { messageField, readModules, type HandedModules } from '../Client';
import { handModules } from '../rewriter';
import WorkerClient, {
	setServiceWorkerPort,
	setWorkerModules,
	setWorkerTransportPort,
} from './Client';
import createWorkerClient from './worker';

const isTransportInit = (event: MessageEvent) =>
	typeof event.data === 'object' &&
	event.data !== null &&
	TRANSPORT_INIT in event.data;

const shared =
	typeof SharedWorkerGlobalScope !== 'undefined' &&
	globalThis instanceof SharedWorkerGlobalScope;

// taken when the bundle loads, before the worker's own script: a message's
// ports as the browser made them (its data is read the same way,
// messageField)
const messagePorts = Reflect.getOwnPropertyDescriptor(
	MessageEvent.prototype,
	'ports',
)?.get;
const portsOf = (event: MessageEvent): readonly MessagePort[] =>
	messagePorts
		? (Reflect.apply(messagePorts, event, []) as readonly MessagePort[])
		: event.ports;
const portListen = MessagePort.prototype.addEventListener;
const portStart = MessagePort.prototype.start;
const portClose = MessagePort.prototype.close;

/**
 * A dedicated worker's first message, from the context that started it
 * (Client.provisionWorkerTransport): its transport port, and with
 * `rewriter: 'wasm'` the compiled modules that context holds, or a port
 * they follow on when they had not reached it yet (WORKER_MODULES). Only
 * the browser's own event is taken: one the worker's script dispatches at
 * itself would otherwise choose the worker's transport and the module that
 * rewrites what it evaluates.
 */
let takeBootstrap: ((event: MessageEvent) => boolean) | undefined;

// The page that constructed this worker posts a transport port before any of
// the worker's own code runs (see Client.provisionWorkerTransport). Listen
// first so the message never reaches the worker's own handlers.
setWorkerTransportPort(
	new Promise<MessagePort>((resolve) => {
		if (shared) {
			// every connecting page offers a port; the first one is used and
			// every offer is kept from the worker's own handlers
			addEventListener('connect', (event) => {
				const port = (event as MessageEvent).ports[0];
				port.addEventListener('message', (message) => {
					if (!isTransportInit(message)) return;
					message.stopImmediatePropagation();
					resolve(message.ports[0]);
				});
				port.start();
			});
			return;
		}

		setWorkerModules(
			new Promise<HandedModules | null>((given) => {
				const give = (modules: HandedModules | null) => {
					// this realm's library rewrites with them from now on, in
					// this task: what the page's next handler evaluates is
					// the module's
					if (modules) handModules(modules);
					given(modules);
				};
				takeBootstrap = (event) => {
					if (!event.isTrusted) return false;
					const transport = messageField(event, TRANSPORT_INIT) !== undefined;
					const field = messageField(event, WORKER_MODULES);
					if (!transport && field === undefined) return false;
					takeBootstrap = undefined;
					removeEventListener('message', handler);
					const ports = portsOf(event);
					// (a worker of a worker has no transport to be handed: its
					// port never comes, as before)
					if (transport) resolve(ports[0]);
					// the modules follow on the message's last port
					const later =
						field === true && ports.length > (transport ? 1 : 0)
							? ports[ports.length - 1]
							: undefined;
					if (!later) {
						give(readModules(event, WORKER_MODULES));
						return true;
					}
					Reflect.apply(portListen, later, [
						'message',
						(message: MessageEvent) => {
							if (!message.isTrusted) return;
							give(readModules(message, WORKER_MODULES));
							Reflect.apply(portClose, later, []);
						},
					]);
					Reflect.apply(portStart, later, []);
					return true;
				};
			}),
		);

		const handler = (event: MessageEvent) => {
			if (takeBootstrap?.(event)) event.stopImmediatePropagation();
		};

		addEventListener('message', handler);
	}),
);

// An emulated service worker's controller posts its port to STomp's service
// worker right after the transport's (docs/service-workers.md); kept from
// the worker's own handlers the same way. Only a dedicated worker gets one.
if (
	typeof SharedWorkerGlobalScope === 'undefined' ||
	!(globalThis instanceof SharedWorkerGlobalScope)
)
	setServiceWorkerPort(
		new Promise<MessagePort>((resolve) => {
			const handler = (event: MessageEvent) => {
				if (
					typeof event.data !== 'object' ||
					event.data === null ||
					!(SW_PORT in event.data)
				)
					return;
				event.stopImmediatePropagation();
				removeEventListener('message', handler);
				resolve(event.ports[0]);
			};
			addEventListener('message', handler);
		}),
	);

// Classic-script global consumed (and deleted) by the inject snippet in
// rewriteJS.ts. See ../dom/entry.ts. A module worker's preamble hands over
// the events it held while it loaded this bundle.
Reflect.defineProperty(globalThis, 'createClient', {
	value: (
		config: Parameters<typeof createWorkerClient>[0],
		codecKey: string,
		held?: MessageEvent[],
	) => {
		// the first message may be among those a module worker's preamble
		// held while it loaded this bundle: taken now, so the modules it
		// brought rewrite what the page's module evaluates from its first
		// statement, and never dispatched again
		if (held && takeBootstrap) {
			const index = held.findIndex((event) => takeBootstrap?.(event));
			if (index !== -1) held.splice(index, 1);
		}
		createWorkerClient(config, codecKey);
		(
			Reflect.get(globalThis, helperNames(config).client) as WorkerClient
		).releaseHeld(held);
	},
	configurable: true,
	writable: true,
});
