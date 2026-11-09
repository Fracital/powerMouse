// a worker whose top-level importScripts fails to load (error-surfaces): it
// reports what its own handler saw, and the import throws uncaught
self.onerror = (message, source, lineno, colno, error) => {
	postMessage({
		onerror: {
			message,
			source,
			lineno,
			colno,
			error: error && { name: error.name, message: error.message },
		},
	});
};
importScripts('/neutral/error-surfaces-missing.js');
