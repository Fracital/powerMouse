// An AudioWorklet processor of the workers suite: a module that imports
// another by a relative specifier, reads and writes members by computed
// keys, calls through optional chains and its port, and reports what a call
// of no function throws. What it posts is compared with the native answer.
import { scale, table } from './worklet-helper.js';

registerProcessor(
	'workers-probe',
	class extends AudioWorkletProcessor {
		constructor(options) {
			super();
			const report = { from: 'worklet' };
			const key = 'sum';
			const values = [1, 2, 3];
			report[key] = 0;
			for (let i = 0; i < values.length; i++) report[key] += values[i] * scale;
			report.table = table[1];
			report.option = options.processorOptions?.['tag'];
			report.missing = this.port?.nothing?.(1) ?? 'skipped';
			const name = 'nothing';
			try {
				this.port[name](1);
			} catch (error) {
				report.error = `${error.name}: ${error.message}`;
			}
			try {
				new values[0]();
			} catch (error) {
				report.construct = `${error.name}: ${error.message}`;
			}
			report.global = Object.getOwnPropertyNames(globalThis)
				.filter((name) => name.startsWith('$'))
				.join();
			report.metaURL = import.meta.url.endsWith('/pages/worklet-processor.js');
			this.port.postMessage(report);
		}
		process() {
			return false;
		}
	},
);
