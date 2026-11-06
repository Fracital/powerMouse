import { ParsedConfig } from '../../config';
import Client from '../Client';

let transportPort: Promise<MessagePort> | undefined;

/** Called by the worker entry once it has started listening for TRANSPORT_INIT. */
export function setWorkerTransportPort(port: Promise<MessagePort>) {
	transportPort = port;
}

export default class WorkerClient extends Client {
	constructor(init: ParsedConfig, global: typeof globalThis) {
		super(init, global);
		this.isWorker = true;
	}
	protected override ownTransportPort(): MessagePort | Promise<MessagePort> {
		if (!transportPort)
			throw new Error('Stomp: this worker was not handed a transport port');

		return transportPort;
	}
}
