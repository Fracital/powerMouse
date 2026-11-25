// Answers to rare reads a proxied document makes as a top-level page or a
// sandboxed one would, deferred parts of the document bundle
// (./deferredParts.ts) made at a document's first: window.viewport.segments
// (modules/Framing.ts) and what an opaque (sandboxed) document is refused
// (modules/Sandbox.ts, modules/ServiceWorker.ts). Few pages read either.
import { withStack } from '../nativeErrors';

/**
 * window.viewport.segments in a page the host frames (the browser's answer
 * is null in every frame): the one rectangle of a window its size, as a
 * top-level page on an ordinary screen reads
 */
export function viewportSegments(global: typeof globalThis): unknown {
	return global.Object.freeze(
		global.Array.of(
			new global.DOMRect(0, 0, global.innerWidth, global.innerHeight),
		),
	);
}

const LACKS_SAME_ORIGIN =
	"The document is sandboxed and lacks the 'allow-same-origin' flag.";

/** what `property` (a write of it: `set`) is refused for in an opaque document, in Chrome's words */
const OPAQUE_REFUSALS: Record<string, string> = {
	localStorage: `Failed to read the 'localStorage' property from 'Window': ${LACKS_SAME_ORIGIN}`,
	sessionStorage: `Failed to read the 'sessionStorage' property from 'Window': ${LACKS_SAME_ORIGIN}`,
	cookie: `Failed to read the 'cookie' property from 'Document': ${LACKS_SAME_ORIGIN}`,
	'set cookie': `Failed to set the 'cookie' property on 'Document': ${LACKS_SAME_ORIGIN}`,
	caches:
		"Failed to read the 'caches' property from 'Window': Cache storage is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag.",
	serviceWorker:
		"Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag.",
	// (databases() words its own way)
	databases:
		"Failed to execute 'databases' on 'IDBFactory': Access to the IndexedDB API is denied in this context.",
};

/**
 * The SecurityError an opaque (sandboxed) document is refused `property`
 * with (a write of it: `set`), or IndexedDB's method of that name
 */
export function opaqueRefusal(
	global: typeof globalThis,
	property: string,
	set = false,
): DOMException {
	return withStack(
		new global.DOMException(
			OPAQUE_REFUSALS[set ? `set ${property}` : property] ??
				`Failed to execute '${property}' on 'IDBFactory': access to the Indexed Database API is denied in this context.`,
			'SecurityError',
		),
	);
}
