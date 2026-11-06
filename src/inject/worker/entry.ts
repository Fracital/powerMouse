import { TRANSPORT_INIT } from '../../transport/messages';
import { setWorkerTransportPort } from './Client';
import createWorkerClient from './worker';

// The page that constructed this worker posts a transport port before any of
// the worker's own code runs (see Client.provisionWorkerTransport). Listen
// first so the message never reaches the worker's own handlers.
setWorkerTransportPort(
	new Promise<MessagePort>((resolve) => {
		const isTransportInit = (event: MessageEvent) =>
			typeof event.data === 'object' &&
			event.data !== null &&
			TRANSPORT_INIT in event.data;

		const shared =
			typeof SharedWorkerGlobalScope !== 'undefined' &&
			globalThis instanceof SharedWorkerGlobalScope;

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

		const handler = (event: MessageEvent) => {
			if (isTransportInit(event)) {
				event.stopImmediatePropagation();
				removeEventListener('message', handler);
				resolve(event.ports[0]);
			}
		};

		addEventListener('message', handler);
	}),
);

// Classic-script global consumed (and deleted) by the inject snippet in
// rewriteJS.ts. See ../dom/entry.ts.
Reflect.defineProperty(globalThis, 'createClient', {
	value: createWorkerClient,
	configurable: true,
	writable: true,
});
