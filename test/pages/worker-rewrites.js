// What a classic dedicated worker evaluates from text (the worker-rewrites
// suite): every way reads the worker's own location, which only rewritten
// code reads as the page's, and every function made from text is kept in
// `__made` for the suite to read as the browser holds it.
const made = (self.__made = {});
const out = {};

/** a function from text at `stage`: how it reads back, and what it reads */
function probe(stage) {
	const fn = new Function(
		'a',
		'/* kept */ return [a, location.href, typeof top];',
	);
	made[stage] = fn;
	return [String(fn), fn(stage)];
}

out.top = probe('top');
out.eval = eval('/* kept */ location.pathname');
out.indirect = (0, eval)('var viaEval = location.host; viaEval');

importScripts(
	'data:text/javascript,' +
		encodeURIComponent(
			'self.viaData = function () { /* kept */ return location.origin; };',
		),
);
out.data = [String(self.viaData), self.viaData()];

importScripts(
	URL.createObjectURL(
		new Blob(['self.viaBlob = function () { return location.search; };']),
	),
);
out.blob = [String(self.viaBlob), self.viaBlob()];

importScripts('/pages/worker-rewrites-dep.js');
out.imported = self.viaImport();

// a timer's text, and a function made in a timer
setTimeout('self.viaTimer = /* kept */ location.href;', 0);
const timed = new Promise((resolve) => {
	setTimeout(() => {
		out.timer = self.viaTimer;
		out.timed = probe('timed');
		resolve();
	}, 50);
});

/** a worker of this worker's and its answer to one message */
const nested = (worker, message) =>
	new Promise((resolve) => {
		worker.onmessage = (event) => resolve(event.data);
		worker.onerror = (event) => resolve('error ' + event.message);
		worker.postMessage(message);
	});
const fromBlob = () =>
	new Worker(
		URL.createObjectURL(
			new Blob([
				"onmessage = () => postMessage([location.protocol, new Function('return typeof top;')()]);",
			]),
		),
	);
// started while this script runs: by URL and from a blob
const child = new Worker('/pages/worker-rewrites-nested.js');
const children = Promise.all([
	nested(child, 'nestedFirst').then((answer) => {
		out.nested = answer;
	}),
	nested(fromBlob(), 'first').then((answer) => {
		out.nestedBlob = answer;
	}),
]);

// the page's first message, and a later one: what each makes the worker
// evaluate, and a worker started for the later one
let first;
const messaged = new Promise((resolve) => {
	first = resolve;
});
onmessage = async (event) => {
	if (event.data === 'First') {
		out.message = probe('message');
		first();
		return;
	}
	// importScripts of text, long after the worker started
	importScripts(
		'data:text/javascript,' +
			encodeURIComponent(
				'self.viaLateData = function () { /* kept */ return location.origin; };',
			),
	);
	made.data = self.viaLateData;
	// a function large enough that the instance that rewrote it is not
	// kept, and what the worker evaluates after it
	importScripts('/pages/worker-rewrites-large.js');
	made.large = new Function('a', self.largeScript());
	postMessage({
		again: probe('again'),
		data: [String(self.viaLateData), self.viaLateData()],
		large: made.large('large'),
		afterLarge: probe('afterLarge'),
		nested: await nested(child, 'nestedAgain'),
		late: await nested(new Worker('/pages/worker-rewrites-nested.js'), 'late'),
		lateBlob: await nested(fromBlob(), 'late'),
	});
};

Promise.all([timed, messaged, children]).then(() => postMessage(out));
