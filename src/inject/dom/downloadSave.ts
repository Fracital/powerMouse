// The Download module's save of a same-origin download (modules/Download.ts):
// the copy fetched through the proxy and saved from a blob: URL under the
// name the browser would pick. A deferred part (./deferredParts.ts), made at
// a document's first such download; its top level reads no global.
import { utf8Text } from '../../byteString';
import { routeBinary } from '../../routeURL';
import StompURL from '../../StompURL';
import { scopePrefix } from '../modules/Unroute';
import type DocumentClient from './Client';
import { loadFetch } from './loadGrants';

/** the name a Content-Disposition header gives, if any */
function dispositionName(header: string | null): string | null {
	if (!header) return null;
	const extended = /filename\*\s*=\s*([\w-]+)''([^;]+)/i.exec(header);
	if (extended)
		try {
			return decodeURIComponent(extended[2].trim());
		} catch (error) {
			// not percent-encoded after all: the plain form below
		}
	const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
	// the header's bytes, which Chrome reads as UTF-8, and names the file
	// from its URL when they are not
	return plain ? utf8Text((plain[2] ?? plain[1]).trim()) : null;
}

/** `url` fetched through the proxy and saved as `named` (or the name it gives) */
export async function saveDownload(
	client: DocumentClient,
	url: URL,
	named: string,
): Promise<void> {
	const response = await loadFetch(
		client,
		new URL(routeBinary(new StompURL(url, client.url)), scopePrefix(client))
			.href,
		// the browser's own download, not a page's read: no CORS (a load
		// the worker takes no metadata from)
		'download',
		{ credentials: 'include' },
	);
	const last = decodeURIComponent(
		url.pathname.slice(url.pathname.lastIndexOf('/') + 1),
	);
	const name =
		named ||
		dispositionName(response.headers.get('content-disposition')) ||
		last ||
		'download';
	const global = client.global;
	const blob = await response.blob();
	const objectURL = global.URL.createObjectURL(blob);
	const anchor = global.document.createElement('a');
	anchor.download = name;
	anchor.href = objectURL;
	anchor.click();
	global.setTimeout(() => global.URL.revokeObjectURL(objectURL), 60000);
}
