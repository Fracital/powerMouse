// Whether bytes match a load's integrity metadata (./sri.ts), by the
// digests of ./sha.ts: the bytes the service worker serves for a load the
// browser must refuse (refusalBytes), and a data: script's or stylesheet's
// check in a document (src/inject/dom/modules/DOMAttributes.ts), where it is
// a deferred part of the document bundle (src/inject/dom/deferred.ts) with
// the page's policy checks, which share the digests, and with the bytes of
// the data: URL it checks.
import { digestBytes } from './sha';
import { strongestItems, type Algorithm } from './sri';

/** whether `bytes` match `metadata` as the browser checks them (metadata naming nothing valid matches anything) */
export function integrityHoldsSync(
	bytes: Uint8Array,
	metadata: string,
): boolean {
	const items = strongestItems(metadata);
	if (!items.length) return true;
	const digests = new Map<Algorithm, string>();
	return items.some(({ algorithm, digest }) => {
		if (!digests.has(algorithm))
			digests.set(algorithm, digestBytes(algorithm, bytes));
		return digests.get(algorithm) === digest;
	});
}

/**
 * Bytes that match none of `metadata`'s digests under the SRI rules
 * (integrityHoldsSync), for the browser to refuse; null when the metadata
 * names nothing valid, which anything matches
 */
export function refusalBytes(metadata: string): Uint8Array | null {
	if (!strongestItems(metadata).length) return null;
	const encoder = new TextEncoder();
	for (let n = 0; ; n++) {
		const bytes = encoder.encode(n ? `/*${n}*/` : '');
		if (!integrityHoldsSync(bytes, metadata)) return bytes;
	}
}

/**
 * The bytes of a data: URL, as the fetch spec's data: URL processor makes
 * them: the body percent-decoded, and base64-decoded where the type says
 * `;base64`; null for one the browser would not load
 */
export function dataURLBytes(url: string): Uint8Array | null {
	const comma = url.indexOf(',');
	if (!/^data:/i.test(url) || comma === -1) return null;
	const header = url.slice(5, comma);
	const body = url.slice(comma + 1).replace(/#.*$/s, '');
	const encoded = new TextEncoder().encode(body);
	const bytes: number[] = [];
	for (let i = 0; i < encoded.length; i++) {
		const hex = String.fromCharCode(encoded[i + 1] ?? 0, encoded[i + 2] ?? 0);
		if (encoded[i] === 0x25 && /^[0-9a-f]{2}$/i.test(hex)) {
			bytes.push(parseInt(hex, 16));
			i += 2;
		} else bytes.push(encoded[i]);
	}
	if (!/;\s*base64\s*$/i.test(header)) return Uint8Array.from(bytes);
	// forgiving-base64: ASCII whitespace goes, and padding is optional
	let text = '';
	for (let at = 0; at < bytes.length; at += 8192)
		text += String.fromCharCode(...bytes.slice(at, at + 8192));
	text = text.replace(/[\t\n\f\r ]/g, '');
	try {
		const binary = atob(text);
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch (error) {
		return null;
	}
}

/**
 * Whether a data: URL's bytes match `metadata` (a data: script's or
 * stylesheet's check in a document, src/inject/dom/modules/DOMAttributes.ts),
 * or null for a URL the browser would not load
 */
export function dataIntegrity(url: string, metadata: string): boolean | null {
	const bytes = dataURLBytes(url);
	return bytes && integrityHoldsSync(bytes, metadata);
}
