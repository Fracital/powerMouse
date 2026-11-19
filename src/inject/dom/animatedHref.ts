// An SVG animation of a link's href (modules/DOMAttributes.ts keeps the
// hook, which says why its values are routed): a deferred part of the
// document bundle (./deferred.ts), made at a document's first animation of
// an href. Its top level reads no global (./deferredParts.ts).
import { routeBinary } from '../../routeURL';
import type StompURL from '../../StompURL';
import type DocumentClient from './Client';
import type { CustomElement } from './modules/DOMHooks';

/** what the hook took of its module */
export interface AnimatedHrefContext {
	moduleClient: DocumentClient;
	/** what the page's URL names, against the document's base */
	pageURL: (value: string) => StompURL;
	/** the values routed, by route: what an animated href's animVal reads back */
	animatedValues: Map<string, string>;
	/** the name of an element's xlink:href, whatever its prefix */
	xlinkName: (element: Element) => string;
	/** the animation's attributes that hold values */
	ANIMATED: string[];
}

/**
 * The values of `element`, an animation of an href, routed: the link's as a
 * link, any other reference's as the file it loads (modules/DOMAttributes.ts)
 */
export function animatedHref(
	element: CustomElement,
	{
		moduleClient,
		pageURL,
		animatedValues,
		xlinkName,
		ANIMATED,
	}: AnimatedHrefContext,
) {
	const animatedTarget = (element: CustomElement): Element | null => {
		const reference =
			element.getAttribute('href') ?? element.getAttribute(xlinkName(element));
		if (reference?.startsWith('#'))
			return (
				(element.getRootNode() as Document | ShadowRoot).getElementById?.(
					reference.slice(1),
				) ?? null
			);
		return element.parentElement;
	};
	const target = animatedTarget(element);
	const link = target ? target.localName === 'a' : null;
	const route = (value: string): string => {
		const trimmed = value.trim();
		if (trimmed === '' || trimmed.startsWith('#')) return value;
		try {
			const url = pageURL(trimmed);
			// (a link's route rewrites a javascript: URL's code)
			if (link === true || url.url.protocol === 'javascript:')
				return moduleClient.linkRoute(url);
			return routeBinary(url);
		} catch (error) {
			// no URL: the browser makes nothing of it either
			return value;
		}
	};
	for (const attribute of ANIMATED) {
		if (!element.hasAttribute(attribute)) continue;
		const value = element.getAttribute(attribute)!;
		// `values` is a list, split at semicolons before any is a URL
		const routed =
			attribute === 'values'
				? value.split(';').map(route).join(';')
				: route(value);
		if (routed === value) continue;
		if (attribute === 'values') {
			const written = value.split(';');
			routed
				.split(';')
				.forEach((part, i) => animatedValues.set(part, written[i]));
		} else animatedValues.set(routed, value);
		element.setAttributeOG(attribute, value);
		element.setAttribute(attribute, routed);
	}
}
