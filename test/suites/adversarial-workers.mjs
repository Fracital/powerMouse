// The worker's view: self.location, self.origin, stacks, fetch and XHR URLs,
// import.meta in a module worker, blob: and data: workers, a SharedWorker and
// a failing worker's ErrorEvent (test/pages/adv-workers.html).
import { runGroup } from '../adversarial.mjs';

await runGroup('workers', {
	'classic worker': 'workers-self-origin',
	'worker from URL object': 'workers-url-argument',
	'module worker': 'workers-module-with-static-import',
	'blob: worker': 'pmwrap-worker-transfer',
	'worker error event': 'workers-error-event',
	'shared worker': 'workers-shared-worker',
	'worker postMessage transfer': 'pmwrap-worker-transfer',
});
