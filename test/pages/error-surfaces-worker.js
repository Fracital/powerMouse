// The worker side of the error-surfaces page, run as a dedicated, a module and
// a shared worker: every error surface a worker's own code can read (its
// error events and onerror, the messages of importScripts, import(), fetch and
// new Worker failures, stacks from its own script, eval, new Function and a
// string timer, resource timing), reported to the page. The page sends
// `{ cross }`, another origin's base, and gets the report back.
const report = { errors: [], onerror: [] };
const describe = (value) =>
	value === null || typeof value !== 'object'
		? String(value)
		: {
				ctor: value.constructor && value.constructor.name,
				name: value.name,
				message: value.message,
				stack: value.stack,
			};
self.addEventListener('error', (event) => {
	report.errors.push({
		ctor: event.constructor.name,
		message: event.message,
		filename: event.filename,
		lineno: event.lineno,
		colno: event.colno,
		error: describe(event.error),
	});
});
self.onerror = (message, source, lineno, colno, error) => {
	report.onerror.push({
		message,
		source,
		lineno,
		colno,
		error: describe(error),
	});
};
async function attempt(name, fn) {
	try {
		report[name] = { value: await fn() };
	} catch (error) {
		report[name] = { threw: describe(error) };
	}
}
function thrower() {
	throw new Error('worker boom');
}
async function probe({ cross }) {
	await attempt('stack', () => thrower());
	await attempt('eval', () => eval('throw new Error("worker eval")'));
	await attempt('function', () =>
		new Function('throw new Error("worker Function")')(),
	);
	await attempt('importScripts404', () =>
		importScripts('/neutral/error-surfaces-missing.js'),
	);
	await attempt('importScriptsBad', () => importScripts('http://[bad'));
	await attempt('dynamicImport', async () => {
		await import('/neutral/error-surfaces-missing-dyn.js');
	});
	await attempt('fetchBad', async () => {
		await fetch('http://[bad');
	});
	await attempt('workerCross', () => {
		if (typeof Worker !== 'function') return 'no Worker';
		new Worker(`${cross}pages/error-surfaces-worker.js`).terminate();
		return 'constructed';
	});
	await attempt('workerBad', () => {
		if (typeof Worker !== 'function') return 'no Worker';
		new Worker('http://[bad').terminate();
		return 'constructed';
	});
	await attempt('resources', () =>
		performance
			.getEntriesByType('resource')
			.map((entry) => entry.name)
			.filter((name) => name.includes('error-surfaces')),
	);
	setTimeout(() => {
		throw new Error('worker uncaught');
	});
	setTimeout('throw new Error("worker timer string")');
	await new Promise((resolve) => setTimeout(resolve, 400));
	return report;
}
if (typeof SharedWorkerGlobalScope === 'function') {
	self.onconnect = (event) => {
		const port = event.ports[0];
		port.onmessage = async ({ data }) => port.postMessage(await probe(data));
	};
} else {
	self.onmessage = async ({ data }) => postMessage(await probe(data));
}
