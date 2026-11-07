// A controller's id names its address under the scope (`/stomp/<id>/`), so
// two host tabs on one scope do not replace each other in the service worker.
// A host that keeps tabs stores the id (sessionStorage) and passes it back,
// so the tab's history entries and copied links keep resolving.

/** what an id may look like: a path segment that needs no encoding */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const ID_LENGTH = 8;
const ID_ALPHABET =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** the id the host gave, checked, or a fresh random one */
export function controllerId(id?: string): string {
	if (id === undefined) return mintId();
	if (typeof id !== 'string' || !ID_PATTERN.test(id))
		throw new TypeError(
			`Stomp: a controller id is 1 to 32 characters of [A-Za-z0-9_-], not ${JSON.stringify(id)}`,
		);
	return id;
}

function mintId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
	let id = '';
	for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
	return id;
}
