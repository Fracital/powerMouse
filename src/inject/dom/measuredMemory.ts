// What performance.measureUserAgentSpecificMemory() answers a proxied page
// with, a deferred part of the document bundle (./deferredParts.ts), made at
// a page's first call (./modules/Isolation.ts installs the wrapper where the
// host's page is isolated): the browser's result with the page's own URLs,
// its frames' `src` as the page wrote them, and nothing of what is not the
// page's (the host's page, the controller's frame, the proxy's own workers),
// whose parts leave the breakdown and their bytes the total.
import { scopePrefix, unrouteURL } from '../modules/Unroute';
import type DocumentClient from './Client';
import { nativeElement } from './modules/DOMHooks';
import { markerPrefix } from './modules/MutationObserver';

/** the result `measured` with only what is the page's, its URLs the page's */
export function measuredMemory(
	client: DocumentClient,
): (measured: unknown) => unknown {
	const global = client.global as typeof globalThis & Record<string, any>;
	const origin = new URL(scopePrefix(client)).origin;
	/** the `src` the page gave the frame whose element has `routed` */
	const written = (id: unknown, routed: string): string => {
		try {
			for (const element of global.document.querySelectorAll(
				'iframe,frame,object,embed',
			) as Iterable<Element>) {
				const get = (name: string) =>
					Reflect.apply(nativeElement.getAttribute, element, [name]) as
						string | null;
				const name = element.localName === 'object' ? 'data' : 'src';
				if (get(name) !== routed || (get('id') ?? '') !== id) continue;
				const marked = get(`${markerPrefix()}${name}`);
				if (marked !== null) return marked;
			}
		} catch (error) {
			// no document to look in: the route's URL
		}
		return unrouteURL(client, routed) ?? routed;
	};
	/** whether a place the browser named is the page's; its URLs made the page's */
	const pages = (where: Record<string, any>): boolean => {
		const container = where.container as
			{ id?: unknown; src?: unknown } | null | undefined;
		if (container && typeof container.src === 'string' && container.src)
			container.src = written(container.id, container.src);
		if (where.scope === 'cross-origin-aggregated')
			// (what is around the page, not in it: the host, in another origin)
			return !!container;
		if (typeof where.url !== 'string' || !where.url.startsWith(origin))
			return true;
		const real = where.url.startsWith(scopePrefix(client))
			? unrouteURL(client, where.url)
			: null;
		if (real === null) return false;
		where.url = real;
		return true;
	};
	const own = (measured: unknown) => {
		try {
			const result = measured as {
				bytes: number;
				breakdown: { bytes: number; attribution: Record<string, any>[] }[];
			};
			for (let index = result.breakdown.length - 1; index >= 0; index--) {
				const part = result.breakdown[index];
				if (!part.attribution.length) continue;
				const kept = part.attribution.filter(pages);
				if (kept.length === part.attribution.length) continue;
				if (!kept.length) {
					result.bytes -= part.bytes;
					result.breakdown.splice(index, 1);
				} else part.attribution.splice(0, part.attribution.length, ...kept);
			}
		} catch (error) {
			// not the shape this knows: as the browser gave it
		}
		return measured;
	};
	return own;
}
