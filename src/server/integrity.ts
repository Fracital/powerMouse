// The service worker's side of subresource integrity (src/sri.ts): the
// origin's bytes against the metadata a route carries.
import { encodeBase64 } from '../base64';
import { digestBytes } from '../sha';
import { base64Standard, type Algorithm } from '../sri';

const STRENGTH: Record<Algorithm, number> = { sha256: 1, sha384: 2, sha512: 3 };
const SUBTLE_NAMES: Record<Algorithm, string> = {
	sha256: 'SHA-256',
	sha384: 'SHA-384',
	sha512: 'SHA-512',
};

interface IntegrityItem {
	algorithm: Algorithm;
	/** base64, padded */
	digest: string;
}

/** the items of a route's mark (what follows INTEGRITY_MARK) */
function markItems(mark: string): IntegrityItem[] {
	const items: IntegrityItem[] = [];
	for (const part of mark.split('.')) {
		const match = /^(256|384|512)-([A-Za-z0-9_-]+)$/.exec(part);
		if (match)
			items.push({
				algorithm: `sha${match[1]}` as Algorithm,
				digest: base64Standard(match[2]),
			});
	}
	return items;
}

/**
 * Whether `bytes` match a route's mark, as the browser decides (the SRI
 * spec's "do bytes match metadataList"): only the strongest algorithm the
 * metadata names counts, and one of its digests must be the bytes'
 */
export async function integrityHolds(
	bytes: Uint8Array<ArrayBuffer>,
	mark: string,
): Promise<boolean> {
	const items = markItems(mark);
	if (!items.length) return true;
	let strongest = items[0].algorithm;
	for (const { algorithm } of items)
		if (STRENGTH[algorithm] > STRENGTH[strongest]) strongest = algorithm;
	const subtle = globalThis.crypto?.subtle;
	const actual = subtle
		? encodeBase64(
				new Uint8Array(await subtle.digest(SUBTLE_NAMES[strongest], bytes)),
			)
		: digestBytes(strongest, bytes);
	return items.some(
		({ algorithm, digest }) => algorithm === strongest && digest === actual,
	);
}
