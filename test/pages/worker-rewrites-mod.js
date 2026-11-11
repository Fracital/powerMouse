// What a module worker evaluates from text (the worker-rewrites suite; see
// worker-rewrites.js).
// a data: module this one imports is rewritten where this one is served,
// from inside its rewrite
import viaStatic from 'data:text/javascript,export%20default%20function%20()%20%7B%20%2F*%20kept%20*%2F%20return%20location.href%3B%20%7D';

const made = (self.__made = {});
const out = {};
made.moduleStatic = viaStatic;
out.static = [String(viaStatic), viaStatic()];

function probe(stage) {
	const fn = new Function(
		'a',
		'/* kept */ return [a, location.href, typeof top];',
	);
	made['module' + stage] = fn;
	return [String(fn), fn(stage)];
}

// set before anything is awaited: a message that comes during an await
// finds its handler
let first;
const messaged = new Promise((resolve) => {
	first = resolve;
});
onmessage = (event) => {
	if (event.data === 'First') {
		out.message = probe('Message');
		first();
	} else postMessage({ again: probe('Again') });
};

out.top = probe('Top');
out.indirect = (0, eval)('/* kept */ location.pathname');

const imported = (
	await import(
		'data:text/javascript,' +
			encodeURIComponent(
				'export default function () { /* kept */ return location.href; }',
			)
	)
).default;
made.moduleData = imported;
out.data = [String(imported), imported()];

await messaged;
postMessage(out);
