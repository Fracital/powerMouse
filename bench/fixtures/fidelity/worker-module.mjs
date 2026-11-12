// A module worker of workers.html.
import { dep } from './worker-dep.mjs';

self.onmessage = function () {
	self.postMessage([import.meta.url, self.location.href, self.origin, dep]);
};
