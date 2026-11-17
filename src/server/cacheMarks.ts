// The service worker's side of the site-marked routes (src/memoryMark.ts):
// the mark of each site, drawn from a secret this worker keeps in its own
// database (stompConfig, beside the codec keys) and never hands to a page or
// a config. A document is told its own site's mark in its shell; no page can
// work out another site's from its own, from the site's name or from the
// route's shape. The build is part of it, so a document of a new build never
// takes what one of an older build left in the renderer.
import { digest } from '../sha';
import { BUILD } from '../version';

/** the consts row the secret is kept under */
export const CACHE_SECRET_KEY = 'cacheMarkSecret';

/** how many characters of the digest a mark keeps (96 bits) */
const MARK_LENGTH = 16;

let secret = '';
const marks = new Map<string, string>();

/** a new secret, as the consts row keeps it */
export function newCacheSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let text = '';
	for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
	return text;
}

/** take on the secret the database keeps (createServer) */
export function useCacheSecret(kept: unknown) {
	if (typeof kept !== 'string' || !/^[0-9a-f]{64}$/.test(kept)) return;
	if (kept === secret) return;
	secret = kept;
	marks.clear();
}

/**
 * The mark of the documents of `site` (a scheme and registrable domain,
 * src/partition.ts siteOf) that the emulated worker `controller` controls
 * (none: uncontrolled ones): '' for no site (an opaque origin's documents)
 * and before the worker has its secret, so their routes carry none
 */
export function cacheMarkOf(site: string | null, controller = ''): string {
	if (!secret || site === null) return '';
	const key = `${site}\n${controller}`;
	let mark = marks.get(key);
	if (mark === undefined) {
		mark = digest('sha256', `${secret}\n${BUILD}\n${key}`)
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.slice(0, MARK_LENGTH);
		if (marks.size >= 4096) marks.clear();
		marks.set(key, mark);
	}
	return mark;
}

/** what stores a secret drawn again (createServer: the consts row) */
let keeper: ((secret: string) => Promise<unknown>) | null = null;
export function keepCacheSecretWith(
	keep: (secret: string) => Promise<unknown>,
) {
	keeper = keep;
}

/**
 * Every site's mark from now on is another (the secret is drawn again and
 * kept): what the renderer keeps under an earlier mark is no document's
 * that loads after this. For a cache cleared by Clear-Site-Data or by the
 * host, which natively empties what the renderers kept too.
 */
export async function renewCacheSecret(): Promise<void> {
	const fresh = newCacheSecret();
	useCacheSecret(fresh);
	await keeper?.(fresh).catch(() => {});
}
