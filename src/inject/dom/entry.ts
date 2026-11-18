import { ownDocumentBundle } from '../../routeURL';
import createDOMClient from './document';

// the file this bundle was loaded from, which the shells this realm makes
// name too (routeURL.ts injectDocumentFile)
const loadedBy = document.currentScript?.getAttribute('src');
if (loadedBy) ownDocumentBundle(new URL(loadedBy, document.baseURI).href);

// Classic-script global consumed (and deleted) by the inject snippet in
// rewriteHTML.ts. Defined with Reflect so it is configurable, unlike a
// top-level `var` from esbuild's `globalName`.
Reflect.defineProperty(globalThis, 'createClient', {
	value: createDOMClient,
	configurable: true,
	writable: true,
});
