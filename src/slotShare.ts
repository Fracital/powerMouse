// The site pool: what a slot's agent (src/controller/slotLibrary.ts) shares
// with the documents of its slot that have no proxied top in reach, a frame
// of another slot than its page's (src/inject/dom/Client.ts #slotShare).
import type { RewriterLib } from './rewriterLight';

/** the global of the agent's window that holds it: named after the client, which no page is told */
export const slotLibraryName = (client: string) => `${client}$slot`;

/** what the agent holds there, frozen, with nothing to call but the library */
export interface SlotShare {
	/** the build of the agent's bundle, and of the library */
	build: string;
	/** the light library, in a realm of the agent's document no page code runs in (src/inject/dom/rewriterRealm.ts) */
	rewriter: RewriterLib;
	/** the light library's statement, for a document's own copy (src/inject/rewriter.ts lightFactory) */
	light: string | null;
	/**
	 * the document bundle's deferred statements (src/inject/dom/deferred.ts),
	 * each by its name (src/version.ts DEFERRED_FACTORY, PASSKEYS_FACTORY,
	 * ACTIVATION_FACTORY): a document asks for one by its name, and a text
	 * that ran on into the others would assign them as its realm's globals
	 */
	deferred: Readonly<Record<string, string>> | null;
}
