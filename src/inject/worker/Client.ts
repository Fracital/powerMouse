import { ParsedConfig } from '../../config';
import Client from '../Client';

export default class WorkerClient extends Client {
	constructor(init: ParsedConfig, global: typeof globalThis) {
		super(init, global);
		this.isWorker = true;
	}
}
