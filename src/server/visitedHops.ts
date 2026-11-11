// What the worker keeps between the hops of a navigation that began at a
// link route (src/visited.ts), by the URL the browser asks for next and for
// a few seconds:
//
// - at a link route the worker itself redirected to (the visited URL's own
//   site's, for Chrome's self-links, or the next URL of a site's own
//   redirect): the context the navigation began in, and the address and
//   route kind its document belongs at, which the first hop read from the
//   navigation's referrer or its document's hint;
// - at the document's address: the context, so a redirect the site answers
//   there goes on through a link route of the same context, as Chrome
//   records every URL of a redirect chain under the navigation's own key.
import type { VisitedContext } from '../visited';

export interface VisitedHop {
	/** the context of the link (or script) that began the navigation */
	context: VisitedContext;
	/** the address of the controller the document belongs to */
	directory?: string;
	/** the nested route marker of the document's frame, false at the top level */
	nested?: string | false;
	/**
	 * How many redirects of the navigation so far were the worker's own (a
	 * link route's): the page's navigation timing counts the site's only
	 * (HOPS_MARKER)
	 */
	hops: number;
	/**
	 * A redirect of the site's own in this navigation went to another
	 * origin: natively the document's navigation timing shows no redirect
	 * then, however many there were
	 */
	crossed?: boolean;
}

const KEPT = 256;
const TTL_MS = 10000;

const hops = new Map<string, VisitedHop & { at: number }>();

const keyOf = (url: string) => url.split('#')[0];

export function rememberVisitedHop(url: string, hop: VisitedHop) {
	const key = keyOf(url);
	hops.delete(key);
	hops.set(key, { ...hop, at: Date.now() });
	if (hops.size > KEPT) hops.delete(hops.keys().next().value!);
}

/** what the hop before a request for `url` left for it, taken */
export function takeVisitedHop(url: string): VisitedHop | null {
	const key = keyOf(url);
	const hop = hops.get(key);
	if (!hop) return null;
	hops.delete(key);
	return Date.now() - hop.at > TTL_MS ? null : hop;
}
