// The body of a function large enough that the wasm instance that rewrites
// it ends the rewrite holding more than a page's thread keeps (the
// worker-rewrites suite evaluates it in a worker and in the page, and
// test/suites/wasm-instances.mjs holds its size to the limit): every
// statement of the block reads the location, none of them runs.
self.largeScript = () =>
	'/* kept */ if (a === null) {\n' +
	'a = self.location.href + a;\n'.repeat(15000) +
	'}\nreturn [a, location.href];';
