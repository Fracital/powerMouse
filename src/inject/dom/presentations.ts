// The presentation ids a site's documents were handed, a deferred part of
// the document bundle (./deferredParts.ts), evaluated at a realm's first
// PresentationRequest start() or reconnect() or connectionavailable event
// (the Storage module hooks those before any page script ran).
//
// PresentationRequest.reconnect(id) joins a presentation a document of the
// origin started, and the browser's origin is every proxied site's: a site
// joins only the presentations its own documents were handed (start,
// reconnect, a connectionavailable event), whose ids are kept in the proxy
// origin's own localStorage beside the Storage module's stamps. Any other id
// is one the browser does not know, and the module asks for an id no
// presentation has, so the browser answers so.
//
// The id is read with the getter of the connection's own prototype, found
// at the first connection (reading PresentationConnection at load would
// make the interface in every frame). A page that changed that getter first
// only lies to itself: an id it makes up joins a presentation only when the
// browser has one of that id, and those are the browser's random ones.
//
// This file's top level reads no global (it may be evaluated after page
// scripts ran).
import type DocumentClient from './Client';

/** the proxy origin's own localStorage, and its native members */
export interface PresentationStore {
	stamps: Storage;
	getItem: Storage['getItem'];
	setItem: Storage['setItem'];
}

export interface PresentationIds {
	/** whether the site's documents were handed a presentation of `id` */
	known(id: string): boolean;
	/** keeps the id of a connection the page is handed, and hands it on */
	learn<T>(connection: T): T;
}

export function presentationIds(
	client: DocumentClient,
	store: PresentationStore,
): PresentationIds {
	let idOf: (() => string) | undefined;
	const listKey = () => `$stomp$presentations:${client.storageKey}`;
	const list = (): string[] => {
		try {
			return JSON.parse(
				Reflect.apply(store.getItem, store.stamps, [listKey()]) ?? '[]',
			);
		} catch (error) {
			return [];
		}
	};
	return {
		known: (id) => list().includes(id),
		learn(connection) {
			try {
				idOf ??= Reflect.getOwnPropertyDescriptor(
					Reflect.getPrototypeOf(connection as object)!,
					'id',
				)!.get as () => string;
				const id = Reflect.apply(idOf, connection, []);
				const ids = list().filter((other) => other !== id);
				ids.push(id);
				Reflect.apply(store.setItem, store.stamps, [
					listKey(),
					JSON.stringify(ids.slice(-32)),
				]);
			} catch (error) {
				// no store of its own (an opaque origin): nothing to rejoin
			}
			return connection;
		},
	};
}
