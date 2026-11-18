// The URL the worker sends a frame's redirect its parent's frame-src
// refuses to, its host naming the URL refused (./csp.ts refusalNamed reads
// it back): the service worker's, and in a document a deferred part's
// (src/inject/dom/siteEvents.ts), so no document bundle carries it. Its
// top level reads no global.
import { BASE32, NAMED_REFUSAL } from './csp';

/**
 * A URL like REFUSED_URL whose host names `url` (its origin alone when the
 * whole does not fit in a host name): where the worker sends a frame's
 * redirect its parent's frame-src refuses. Chrome names a refused
 * navigation by the URL it refused, its origin only when it is another
 * origin than the policy's document's, and the inject reads the host back
 * (refusalNamed) as the page's URL.
 */
export function namedRefusal(url: string): string {
	const encode = (text: string) => {
		let bits = 0;
		let value = 0;
		let out = '';
		for (const byte of new TextEncoder().encode(text)) {
			value = (value << 8) | byte;
			bits += 8;
			while (bits >= 5) {
				out += BASE32[(value >>> (bits - 5)) & 31];
				bits -= 5;
			}
		}
		if (bits) out += BASE32[(value << (5 - bits)) & 31];
		return out;
	};
	let name = encode(url.replace(/#.*$/s, ''));
	if (name.length > 220) name = encode(new URL(url).origin);
	return `https://${name.replace(/.{1,60}/g, '$&.').slice(0, -1)}${NAMED_REFUSAL}:1/`;
}
