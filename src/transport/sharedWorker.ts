// A transport's SharedWorker (TransportDescriptor.sharedWorker): what every
// tab of the origin runs once for its transports, as one Tor client for all
// of them. A dedicated worker cannot start a SharedWorker, so the
// controller, in the page, starts it and hands its port to the transport
// as its first option's `sharedWorker`, as it hands the carrier host's to
// the transport worker (carrierClient.ts startCarrierHost).

/** the SharedWorker's name, the same in every page so they meet in one */
export const sharedWorkerName = (script: string) => `stomp-shared ${script}`;

/** a port to the SharedWorker running `script` (a module), or null where there is none (Chrome on Android) or it cannot start */
export function startSharedWorker(script: string): MessagePort | null {
	if (typeof SharedWorker !== 'function') return null;
	try {
		const worker = new SharedWorker(script, {
			type: 'module',
			name: sharedWorkerName(script),
		});
		worker.addEventListener('error', () => {});
		return worker.port;
	} catch {
		return null;
	}
}

/**
 * The descriptor with a port to its SharedWorker as its first option's
 * `sharedWorker`, and that port to transfer with it; the descriptor as it
 * is without `sharedWorker`, where no SharedWorker starts, or where its
 * first option is no object (the transport then runs without one). A new
 * port, so a new SharedWorker connection, at each call: one for each
 * construction the controller asks for (the worker's, the page's after a
 * worker that failed, each setTransport).
 */
export function withSharedWorker<
	T extends { sharedWorker?: string; options?: unknown[] },
>(descriptor: T, base: string): { descriptor: T; transfer: MessagePort[] } {
	const unchanged = { descriptor, transfer: [] };
	if (typeof descriptor.sharedWorker !== 'string') return unchanged;
	const [first, ...rest] = descriptor.options ?? [];
	if (first !== undefined && (typeof first !== 'object' || first === null))
		return unchanged;
	const port = startSharedWorker(new URL(descriptor.sharedWorker, base).href);
	if (!port) return unchanged;
	return {
		descriptor: {
			...descriptor,
			options: [{ ...(first as object), sharedWorker: port }, ...rest],
		},
		transfer: [port],
	};
}
