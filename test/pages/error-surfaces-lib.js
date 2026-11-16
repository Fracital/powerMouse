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
	// uncaught, from a builtin the page calls through `call` (which the
	// proxy hooks): the browser places it at the page's call
	builtinThroughCallLater() {
		setTimeout(() => JSON.parse.call(JSON, '{'));
	},
	// a page function that throws inside calls the proxy hooks, three deep
	// (each URL given to replaceState names the next as it is converted),
	// from under a few functions of the page's: natively the stack is the
	// first ten frames of the page's, whatever the hooks run in between
	deepThroughHooks() {
		const url = (depth) => ({
			toString() {
				if (depth === 0) throw new Error('deep');
				history.replaceState(history.state, '', url(depth - 1));
				return location.href;
			},
		});
		function hooked() {
			history.replaceState(history.state, '', url(3));
		}
		function one() {
			hooked();
		}
		function two() {
			one();
		}
		function three() {
			two();
		}
		try {
			three();
		} catch (error) {
			return error.stack;
		}
	},
	// Error.stackTraceLimit as V8 reads it: numbers cut the stack (none
	// below one, all for Infinity), anything else captures none (stack
	// undefined, the formatter not asked); its descriptor, deletion (Error
	// inherits it then) and the limit an error was made under
	stackLimits() {
		const out = {};
		const deep = (n, f) => (n === 0 ? f() : deep(n - 1, f));
		const frames = (error) =>
			typeof error.stack === 'string'
				? error.stack.split('\n').length - 1
				: typeof error.stack;
		const describe = () => {
			const own = Object.getOwnPropertyDescriptor(Error, 'stackTraceLimit');
			return own
				? `${typeof own.value}:${String(own.value)}:${'get' in own}:${own.writable}${own.enumerable}${own.configurable}`
				: 'none';
		};
		out.initial = describe();
		out.keys = Reflect.ownKeys(Error).join();
		const values = {
			zero: 0,
			negative: -1,
			nan: NaN,
			infinity: Infinity,
			fraction: 2.7,
			three: 3,
			text: '5',
			nothing: null,
			numberObject: Object(4),
		};
		for (const [name, value] of Object.entries(values)) {
			Error.stackTraceLimit = value;
			let asked = null;
			const made = deep(20, () => new Error(name));
			const thrown = (() => {
				try {
					deep(20, () => null.x);
				} catch (error) {
					return error;
				}
			})();
			Error.prepareStackTrace = (error, sites) => {
				asked = sites.length;
				return 'formatted';
			};
			const formatted = deep(20, () => new Error(name)).stack;
			delete Error.prepareStackTrace;
			const captured = {};
			deep(20, () => Error.captureStackTrace(captured));
			out[name] = [
				Error.stackTraceLimit,
				frames(made),
				frames(thrown),
				asked,
				formatted,
				frames(captured),
				describe(),
			].join();
		}
		Error.stackTraceLimit = 10;
		Object.defineProperty(Error, 'stackTraceLimit', {
			get: () => 3,
			configurable: true,
		});
		out.getter = [Error.stackTraceLimit, frames(deep(20, () => new Error()))];
		delete Error.stackTraceLimit;
		out.deleted = [
			String(Error.stackTraceLimit),
			'stackTraceLimit' in Error,
			Reflect.ownKeys(Error).join(),
			frames(deep(20, () => new Error())),
		].join();
		Function.prototype.stackTraceLimit = 2;
		out.inherited = [
			Error.stackTraceLimit,
			frames(deep(20, () => new Error())),
		].join();
		delete Function.prototype.stackTraceLimit;
		Error.stackTraceLimit = 4;
		out.added = [describe(), Reflect.ownKeys(Error).join()].join();
		TypeError.stackTraceLimit = 1;
		out.subclass = [
			Object.getOwnPropertyDescriptor(TypeError, 'stackTraceLimit').value,
			Error.stackTraceLimit,
			frames(deep(20, () => new TypeError())),
		].join();
		delete TypeError.stackTraceLimit;
		// raised around the making of an error, put back before its stack is
		// read
		Error.stackTraceLimit = 30;
		const raised = deep(40, () => new Error());
		const captured = {};
		deep(40, () => Error.captureStackTrace(captured));
		class Own extends Error {}
		const own = deep(40, () => new Own());
		Error.stackTraceLimit = 2;
		const lowered = deep(40, () => new Error());
		Error.stackTraceLimit = 10;
		out.madeUnder = [
			frames(raised),
			frames(captured),
			frames(own),
			frames(lowered),
		].join();
		return out;
	},
};
