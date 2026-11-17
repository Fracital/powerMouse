// The site pool: a slot's agent holds the rewriter library for the
// documents of its slot that have no proxied top in reach. A frame of a site
// in another slot than its page's is out of reach of every window above it
// (another origin), so on its own it would make what only a top makes: a
// realm for the library, the library evaluated there, and an instance of the
// rewriter's module, for each such frame (an ad or a cookie-sync frame of
// another site, often dozens on a page). The agent is of the slot's origin
// and in its documents' process, a frame of the hub's page they can reach,
// so it makes one for them (src/inject/dom/Client.ts #slotShare), as a top
// makes one for the frames under it, and the first frame that is handed the
// controller's compiled module gives it to that library.
//
// It is made before the agent says it is ready, so before any document of
// its slot exists: no page code has run in this origin, the realm is made
// with the browser's own methods (rewriterRealm.ts) and removed again, and
// what the frames read is a frozen object of strings and the library, under
// a name of the client's that no page is told, made for good.
import { helperNames } from '../helperNames';
import { createRewriterRealm } from '../inject/dom/rewriterRealm';
import type { RewriterLib } from '../rewriterLight';
import { slotLibraryName, type SlotShare } from '../slotShare';
import { BUILD, DEFERRED_FACTORY, LIGHT_FACTORY } from '../version';

/**
 * The light library and the deferred parts' statements of the library's
 * file (build.js writes the second after a line break, and the first has no
 * line that starts with its name)
 */
function statements(file: string): [light: string, deferred: string | null] {
	const at = file.lastIndexOf(`\n${DEFERRED_FACTORY}=`);
	return at === -1 ? [file, null] : [file.slice(0, at), file.slice(at + 1)];
}

/**
 * Make the slot's library from the library's `file` (the agent's controller
 * read it: StompController.libraryText) and keep it on this window for the
 * documents of the slot. False when it cannot be made (a policy that refuses
 * eval here): those documents then make their own, as without it.
 */
export function shareSlotLibrary(
	file: string | null,
	config: object | null | undefined,
): boolean {
	if (typeof file !== 'string') return false;
	try {
		const [light, deferred] = statements(file);
		const factory = new Function(
			LIGHT_FACTORY,
			`${light}\n;return ${LIGHT_FACTORY};`,
		)() as unknown;
		if (typeof factory !== 'function') return false;
		const rewriter = createRewriterRealm(
			document,
			() => factory as (realm?: Record<string, unknown>) => RewriterLib,
		);
		if (!rewriter || rewriter.build !== BUILD) return false;
		const share: SlotShare = Object.freeze({
			build: BUILD,
			rewriter,
			light,
			deferred,
		});
		return Reflect.defineProperty(
			window,
			slotLibraryName(helperNames(config).client),
			{
				value: share,
				enumerable: false,
				writable: false,
				configurable: false,
			},
		);
	} catch (error) {
		console.warn('Stomp: the slot could not share a rewriter library', error);
		return false;
	}
}
