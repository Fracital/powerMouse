// The audio worklet of the realm-surface suite: its global scope is walked
// when the page makes the processor, and the record goes back through the
// processor's port.
import './realm-walker.js';

registerProcessor(
	'realm-surface',
	class extends AudioWorkletProcessor {
		constructor() {
			super();
			const walker = globalThis.__realmWalker;
			const report = { realmSurface: 'audio-worklet' };
			const send = () => this.port.postMessage(report);
			try {
				walker.walkSettled(globalThis, {}).then(
					(result) => {
						report.lines = walker.lines(result);
						report.counts = result.counts;
						send();
					},
					(error) => {
						report.error = String(error?.stack ?? error);
						send();
					},
				);
			} catch (error) {
				report.error = String(error?.stack ?? error);
				send();
			}
		}
		process() {
			return false;
		}
	},
);
