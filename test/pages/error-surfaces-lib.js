// functions the error-surfaces page calls from an external script, so the
// stacks and messages they produce name this script (error-surfaces suite)
window.surfaces = {
	thrower() {
		throw new Error('external boom');
	},
	evalThrow() {
		eval('throw new Error("from eval")');
	},
	functionThrow() {
		new Function('throw new Error("from Function")')();
	},
	uncaughtEval() {
		setTimeout(() => eval('throw new Error("uncaught eval")'));
	},
	dynamicImport() {
		return import('/neutral/error-surfaces-missing-dyn.js');
	},
	dynamicImportUnhandled() {
		import('/neutral/error-surfaces-missing-dyn2.js');
	},
	// uncaught, from a call the proxy hooks: the browser places it here
	badWorkerLater() {
		setTimeout(() => new Worker('http://[bad'));
	},
};
