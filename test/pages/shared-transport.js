// The transport-worker suite's transport with a SharedWorker
// (TransportDescriptor.sharedWorker): epoxy, which also says on the port it
// was given where it runs; shared-transport-worker.js answers on the
// suite's BroadcastChannel.
import Epoxy from '/neutral/transport.mjs';

export default class SharedTransport extends Epoxy {
	constructor({ sharedWorker, ...options }) {
		super(options);
		if (sharedWorker instanceof MessagePort)
			sharedWorker.postMessage({
				realm: typeof WorkerGlobalScope === 'function' ? 'worker' : 'page',
			});
	}
}
