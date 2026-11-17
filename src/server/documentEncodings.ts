/**
 * The legacy encoding of each document the worker served (documentEncoding
 * in src/server/charset.ts), by the client id of the document: a classic
 * script or a stylesheet the document loads that names no encoding (no byte
 * order mark, no Content-Type charset, for a sheet no @charset) is decoded
 * with it, natively (the document's encoding is their fallback, a sheet's
 * "environment encoding"). A UTF-8 document is not kept, nor one in UTF-16
 * (its subresources are left as UTF-8). Kept in memory: a restarted worker
 * forgets them, and such a resource is then decoded as UTF-8.
 */
const encodings = new Map<string, string>();
const KEPT = 512;

/** the document the client `clientId` is was served in `encoding` */
export function rememberDocumentEncoding(
	clientId: string | undefined,
	encoding: string,
) {
	if (!clientId) return;
	encodings.delete(clientId);
	if (encoding === 'utf-8' || encoding.startsWith('utf-16')) return;
	if (encodings.size >= KEPT) encodings.delete(encodings.keys().next().value!);
	encodings.set(clientId, encoding);
}

/** the encoding of the document `clientId`, for what it loads; UTF-8 when it is not known */
export const documentEncodingOf = (clientId: string | undefined): string =>
	(clientId && encodings.get(clientId)) || 'utf-8';
