// A click on a link with a fragment, as the Fragment module has it go to
// the fragment as written (./modules/Fragment.ts says why), a deferred part
// of the document bundle (./deferredParts.ts) made at a document's first
// such click: most documents' links name no fragment.
import { routeHTML } from '../../rewriteHTML';
import StompURL from '../../StompURL';
import { beforeFragment } from '../../urlShape';
import { unrouteURL } from '../modules/Unroute';
import type DocumentClient from './Client';
import type FragmentModule from './modules/Fragment';
import { hookWrite } from './modules/MutationObserver';

/** what the module took before any page script ran, and its state */
export interface FragmentLinks {
	/** the document's address, as the browser has it */
	href(): string;
	/** `callback` in a task of its own, after the click's navigation */
	post(callback: () => void): void;
	setAttribute: Element['setAttribute'];
	/** the page's same-document navigations not yet done */
	inFlight(): number;
	/** the current entry's fragment sealed again */
	seal(): void;
}

/**
 * The link `link` (its href `routed`, which has a fragment), clicked to
 * navigate this document: when it names this document, its href is the
 * route with the fragment as written (`fragment`'s live) for the time of
 * the activation only
 */
export function fragmentLink(
	client: DocumentClient,
	fragment: FragmentModule,
	link: Element,
	routed: string,
	{ href, post, setAttribute, inFlight, seal }: FragmentLinks,
) {
	// the URL it stands for (a link route's too), as this document's
	// own address would name it: a link to this document only
	let address: string;
	try {
		const real = unrouteURL(client, new URL(routed, href()).href);
		if (real === null) return;
		const url = new URL(real);
		if (beforeFragment(url) !== beforeFragment(client.url.url)) return;
		address = new URL(
			routeHTML(
				new StompURL(url, client.url),
				client.url,
				client.config,
				false,
				client.nestedRoute,
			),
			href(),
		).href;
	} catch (error) {
		return;
	}
	const live = fragment.live(address);
	if (live === address) return;
	const set = (value: string) =>
		hookWrite(
			link,
			() => ['href'],
			() => Reflect.apply(setAttribute, link, ['href', value]),
		);
	set(live);
	// back as soon as the browser took it (it navigates right after the
	// click, or never: a cancelled click)
	post(() => {
		set(routed);
		// a click the page cancelled: the entry made ready for it is sealed
		if (!inFlight()) seal();
	});
}
