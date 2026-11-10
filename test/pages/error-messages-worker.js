// test/suites/error-messages.mjs: failing expressions in a dedicated worker
const o = { arrow: () => 1 };
let k = 'nope';
let fk = 'arrow';
let nul = null;
const cases = {
	'worker: o[k]()': () => o[k](),
	'worker: new o[fk]()': () => new o[fk](),
	'worker: o[k].x()': () => o[k].x(),
	'worker: location.foo()': () => location.foo(),
	'worker: nul[k]': () => nul[k],
	'worker: [...o[k]]': () => [...o[k]],
	'worker: const { a } = o[k]': () => {
		const { a } = o[k];
		return a;
	},
};
const results = {};
for (const [name, run] of Object.entries(cases))
	try {
		run();
		results[name] = { threw: false };
	} catch (error) {
		results[name] = {
			message: error.message,
			constructor: error.constructor === TypeError ? 'TypeError' : 'other',
			header: String(error.stack).split('\n')[0],
		};
	}
postMessage(results);
