import createDOMClient from './document';

// Classic-script global consumed (and deleted) by the inject snippet in
// rewriteHTML.ts. Defined with Reflect so it is configurable, unlike a
// top-level `var` from esbuild's `globalName`.
Reflect.defineProperty(globalThis, 'createClient', {
	value: createDOMClient,
	configurable: true,
	writable: true,
});
