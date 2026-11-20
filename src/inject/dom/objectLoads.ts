// The loads of an <object>'s data and an <embed>'s src
// (modules/DOMAttributes.ts, which says why they are copies): a deferred
// part of the document bundle (./deferredParts.ts), made at a document's
// first object or embed with a URL. The module keeps the hooks and the
// natives it took when it applied, before any page script ran, and hands
// them over; this file's top level reads no global.
import { isXMLDocumentMime, routeHTML } from '../../rewriteHTML';
import { proxyBlobURL, ROUTE_PROTOCOLS, routeXHR } from '../../routeURL';
import type StompURL from '../../StompURL';
import MixedContentModule from '../modules/MixedContent';
import { usePrototype } from '../modules/Proxy';
import { scopePrefix } from '../modules/Unroute';
import { LazyWeakMap } from '../ownCollections';
import type DocumentClient from './Client';
import { deferred } from './deferred';
import { loadFetch } from './loadGrants';
import { CustomElement, nativeElement } from './modules/DOMHooks';
import {
	hiddenSuffix,
	isHiddenValue,
	unseenWrite,
} from './modules/MutationObserver';

/** what DOMAttributes hands the loads, taken when it applied */
export interface ObjectLoadsContext {
	moduleClient: DocumentClient;
	realm: typeof globalThis;
	NativeBlob: typeof Blob;
	/** what the page's URL `value` names, against the document's base */
	pageURL: (value: string) => StompURL;
	/** HTMLObjectElement's contentWindow getter */
	objectWindow: Function;
	/** Node's isConnected getter */
	connected: Function;
	/** the realm's btoa */
	toBase64: (data: string) => string;
}

/** a document's object and embed loads (objectLoads) */
export type ObjectLoads = ReturnType<typeof objectLoads>;

/**
 * The loads of a document's objects and embeds: `load` copies the URL the
 * page wrote (already its marker's) for the element, `typeHook` is the
 * type attribute's hook past its check, `heldBlank` puts a held context
 * back on about:blank before the page reads it
 */
export function objectLoads({
	moduleClient,
	realm,
	NativeBlob,
	pageURL,
	objectWindow,
	connected,
	toBase64,
}: ObjectLoadsContext) {
	// <object data> and <embed src>: Chrome never routes their loads through
	// a service worker, so a routed URL would reach the proxy origin's own
	// server. The inject fetches the resource through the proxy instead and
	// hands the element a blob: URL of it: HTML wrapped in the shell (as a
	// blob document, its real URL as base), anything else as it came. The
	// element loads nothing until then; a later value wins over a load
	// still in flight, and a failed fetch falls back to the routed URL.
	// The attribute and the property read back as the page wrote them.
	// per element: the URL the page wrote, the load for it, and the blob:
	// URL once it is in. A hook that runs again for the same value (the
	// insertion hooks re-run every attribute hook) keeps the load and its
	// blob instead of starting over, which would reset a document the
	// element is already showing
	const loads = new LazyWeakMap<
		Element,
		{ written: string; generation: number; url?: string; attached?: boolean }
	>();
	let generations = 0;
	// The element stands on about:blank# while its copy is on its way: a
	// fragment of its context's initial about:blank, which Chrome goes to
	// at once and fires no load for, as natively while the document loads
	// (no URL with a type shows an empty document of that type and fires
	// load, and so does about:blank: Chrome 157 fired load twice, natively
	// once). Before the page reads the context, its URL is put back to
	// the about:blank it is natively
	const HELD = 'about:blank#';
	const heldBlank = (
		element: Element,
		context: typeof globalThis | null = element instanceof
		realm.HTMLObjectElement
			? (Reflect.apply(objectWindow, element, []) as typeof globalThis | null)
			: null,
	) => {
		const state = loads.get(element);
		try {
			if (state && !state.url && context?.location.href === HELD)
				Reflect.apply(context.History.prototype.replaceState, context.history, [
					null,
					'',
					'about:blank',
				]);
		} catch (error) {
			// another context already
		}
	};
	// a load that fails as a failed fetch does, with no request: an
	// object fires error and shows no document (a revoked blob: of this
	// origin, which a context the element already has fails on too,
	// where it stays on its document for one of no origin), an embed
	// nothing (a blob: URL of no origin, never minted: a revoked one of
	// this origin would fire an embed's load)
	let revoked: string | undefined;
	const fail = (element: CustomElement, attribute: string) => {
		if (attribute === 'data' && !revoked) {
			const minted = realm.URL.createObjectURL(new NativeBlob([]));
			realm.URL.revokeObjectURL(minted);
			revoked = proxyBlobURL(minted);
		}
		// (as the document of no type it is natively, before the URL)
		release(element);
		element.setAttribute(
			attribute,
			attribute === 'data' ? revoked! : 'blob:null/failed',
		);
	};
	// One Chrome shows as an image has no context while its image loads,
	// and fails on about:blank# (Chrome 157: error, where natively it
	// loads): a type of an image (an SVG is a document), or without a
	// type a URL whose extension names one. Chrome reads the type as
	// written: one with whitespace around it names none it knows. It is held with no URL,
	// which it loads nothing for, again when its type changes while the
	// copy is on its way (a type set after the data)
	const IMAGE_TYPE = /^image\/(?!svg\+xml\s*(;|$))/i;
	const IMAGE_PATH =
		/\.(png|jpe?g|jfif|pjp(eg)?|gif|webp|avif|apng|bmp|ico|cur)$/i;
	/** whether Chrome shows the element as an image: by its type, by its URL ('untyped'), or not (false) */
	const imageShown = (
		element: CustomElement,
		real = false,
	): boolean | 'untyped' => {
		// the page's type (the one it wrote, none for one it has none of),
		// or with `real` the one Chrome goes by
		const written = real
			? (Reflect.apply(nativeElement.getAttribute, element, ['type']) as
					string | null)
			: (element.getAttributeOG('type') ?? element.getAttribute('type'));
		const type = !real && isHiddenValue(written) ? null : written;
		return type
			? IMAGE_TYPE.test(type)
			: IMAGE_PATH.test(new URL(loads.get(element)!.written).pathname) &&
					'untyped';
	};
	// Chrome lays an object out as an image or as an embedded document
	// when it is attached, by its type or its URL then: one held with no
	// URL is a document (300x150) for the image it is given. One shown as
	// an image by its URL is held with a type of an image the page does
	// not see (hiddenSuffix, DOMHooks isHidden), a blank one of the page's
	// in its marker, which is taken off once its copy is in (Chrome 157:
	// no context and no event while held, the image's size and one load
	// after, as natively). Its URL comes first: with no type and no URL
	// Chrome lays it out as a document again
	const heldType = () => `image/png${hiddenSuffix()}`;
	const hide = (element: CustomElement) => {
		const type = element.getAttribute('type');
		if (isHiddenValue(type)) return;
		if (type !== null) element.setAttributeOG('type', type);
		unseenWrite(element, 'type');
		element.setAttribute('type', heldType());
	};
	// The page's type in place of the held one, once Chrome went by the
	// URL (Chrome 157: an image stays one, whatever the type then): one
	// it wrote once Chrome had gone by the held one stays in its marker
	// until then. (One Chrome went by that the page wrote is not held,
	// and changed with the URL it would count: a type the page wrote
	// after it stays in its marker.)
	const release = (element: CustomElement) => {
		const page = element.getAttributeOG('type');
		if (!isHiddenValue(element.getAttribute('type'))) return;
		unseenWrite(element, 'type');
		element.removeAttributeOG('type');
		if (page === null) element.removeAttribute('type');
		else element.setAttribute('type', page);
	};
	/**
	 * Whether Chrome went by the element's type and URL already: natively
	 * it does when the element is put in the document with its URL (one
	 * given its URL there decides later)
	 */
	const decided = (element: Element) => {
		const state = loads.get(element);
		return (
			!!state &&
			!state.url &&
			!state.attached &&
			element.localName === 'object' &&
			(Reflect.apply(connected, element, []) as boolean)
		);
	};
	/** with `kept`, by the type Chrome went by (decided), which stays */
	const hold = (element: CustomElement, attribute: string, kept = false) => {
		const shown = imageShown(element, kept);
		if (!kept)
			if (shown === 'untyped' && attribute === 'data') hide(element);
			else release(element);
		const held = shown ? null : HELD;
		if (element.getAttribute(attribute) === held) return;
		unseenWrite(element, attribute);
		// (after the type: one of an image fails on about:blank#)
		element.attributeTab.delete(attribute);
		if (held === null) element.removeAttribute(attribute);
		else {
			element.setAttribute(attribute, held);
			queueMicrotask(() => heldBlank(element));
		}
	};
	// The page's type, while the copy is on its way. Natively one written
	// once the object was put in the document with its URL changes
	// nothing (Chrome went by the one it had then): the page's goes in
	// the marker, the one Chrome went by stays (hidden when the page
	// removed it) until the copy is in (release). Before, it decides, and
	// the element is held again by it. After the copy is in, the page's
	// stands.
	const typeHook = (element: CustomElement) => {
		const state = loads.get(element);
		const type = Reflect.apply(nativeElement.getAttribute, element, [
			'type',
		]) as string | null;
		if (decided(element)) {
			const page = element.getAttribute('type');
			if (page !== null) element.setAttributeOG('type', page);
			const kept =
				page !== null || type === null || isHiddenValue(type)
					? type
					: type + hiddenSuffix();
			if (kept === null) element.removeAttribute('type');
			else element.setAttribute('type', kept);
			return;
		}
		element.removeAttributeOG('type');
		if (state && !state.url)
			hold(element, element.localName === 'object' ? 'data' : 'src');
	};
	const load = (element: CustomElement, attribute: string) => {
		const written = element.getAttribute(attribute)!;
		// the clone a document's markup is rewritten on (an inert
		// document's, see Client.load and WriteStream): the parser makes the
		// real element from the markup serialized from it, which gets its
		// copy after the write (writtenLoads). A copy settled here would
		// land on the clone, and the real one would load nothing. One
		// shown as an image by its URL is written held as one (hide), so
		// the parser lays the real one out as the image
		if (element.ownerDocument !== realm.document) {
			loads.set(element, {
				written: pageURL(written).url.href,
				generation: 0,
			});
			if (attribute === 'data' && imageShown(element) === 'untyped')
				hide(element);
			loads.delete(element);
			element.removeAttribute(attribute);
			return;
		}
		const resource = pageURL(written);
		const routedOf = () =>
			routeHTML(
				resource,
				moduleClient.baseURL,
				moduleClient.config,
				false,
				moduleClient.childRoute,
			);
		// the page's object-src (src/csp.ts): the browser refuses and
		// reports what it refuses, where the browser's copy of the policy
		// refuses it too (the copy itself is a blob: URL, which the copy
		// allows wherever the page allows any load)
		const refused = moduleClient.loadRefusal('object-src', resource.url, true);
		if (refused !== null) {
			loads.delete(element);
			element.setAttribute(attribute, refused);
			return;
		}
		let routed = routedOf();
		// a blob: of the page's is copied like a fetched resource: as it is
		// it would show a document of the proxy's origin, unrewritten
		const fromBlob = resource.url.protocol === 'blob:';
		if (!fromBlob && !ROUTE_PROTOCOLS.includes(resource.url.protocol)) {
			// data: and the like: as routeHTML leaves them
			element.setAttribute(attribute, routed);
			return;
		}
		// mixed content (src/mixedContent.ts): the resource is copied here,
		// never reaching the worker as the element's, so the page's URL
		// decides here. A blocked one fails to load, as natively (an object
		// fires error); an upgraded one loads over https
		const mixed = fromBlob
			? undefined
			: moduleClient
					.getModule(MixedContentModule)
					?.verdict(resource.url, attribute === 'data' ? 'object' : 'embed');
		if (mixed?.action === 'upgrade') {
			resource.url = mixed.url;
			routed = routedOf();
		}
		if (mixed?.action === 'block') {
			// told once: the insertion hooks run this again for the same value
			if (loads.get(element)?.written !== resource.url.href) {
				loads.set(element, {
					written: resource.url.href,
					generation: ++generations,
				});
				moduleClient.getModule(MixedContentModule)!.report(mixed.notices);
			}
			// a load that fails as the blocked one does (no copy on its way)
			fail(element, attribute);
			loads.get(element)!.url = element.getAttribute(attribute)!;
			return;
		}
		const current = loads.get(element);
		if (current?.written === resource.url.href) {
			if (current.url) element.setAttribute(attribute, current.url);
			else hold(element, attribute, decided(element));
			return;
		}
		const generation = ++generations;
		const state: {
			written: string;
			generation: number;
			url?: string;
			attached?: boolean;
		} = {
			written: resource.url.href,
			generation,
			attached: Reflect.apply(connected, element, []),
		};
		loads.set(element, state);
		// nothing to load until the proxied copy is in (an empty URL makes
		// an object show its fallback and not load again)
		hold(element, attribute);
		const settle = (value: string | null) => {
			if (loads.get(element) !== state) return;
			usePrototype(element, CustomElement.prototype, (element) => {
				if (value === null) fail(element, attribute);
				else {
					element.setAttribute(attribute, value);
					// (after the URL, which Chrome goes by then)
					release(element);
				}
				// (the hooks' view: the URL the element was given)
				state.url = element.getAttribute(attribute)!;
			});
		};
		// without the shell's part (deferred.ts) the element loads nothing:
		// a failed fetch's error and no request (the route would go to
		// the proxy origin's server, never through a worker)
		let partless = false;
		// the copy goes out as the load it stands for (loadGrants.ts); a
		// blob: is read at once, as the browser resolves it at the load
		(fromBlob
			? moduleClient.nativeFetch(routeXHR(resource))
			: loadFetch(
					moduleClient,
					new URL(routeXHR(resource), scopePrefix(moduleClient)).href,
					// Chrome loads an object's or embed's resource as a nested
					// context: mode navigate, destination its element
					attribute === 'data' ? 'object navigate' : 'embed navigate',
				)
		)
			.then(async (response) => {
				if (!response.ok && response.status !== 0)
					throw new Error(String(response.status));
				const type = response.headers.get('content-type') ?? '';
				const mime = type.split(';')[0].trim().toLowerCase();
				const html = mime === 'text/html' || mime === 'application/xhtml+xml';
				const xml = !html && isXMLDocumentMime(mime);
				partless = true;
				const writeHTML = html ? deferred('modifyHTML') : null;
				const writeXML = xml ? deferred('modifyXML') : null;
				partless = false;
				// an XML document (an SVG, a feed) runs its XHTML scripts too:
				// it gets the XML shell, under its own mime
				const blob = html
					? new NativeBlob(
							[
								writeHTML!(
									await response.text(),
									resource,
									moduleClient.config,
									true,
									undefined,
									moduleClient.scriptNonce,
								),
							],
							{ type: 'text/html' },
						)
					: xml
						? new NativeBlob(
								[
									writeXML!(
										await response.text(),
										resource,
										moduleClient.config,
										mime,
										undefined,
										undefined,
										false,
										undefined,
										undefined,
										undefined,
										true,
									),
								],
								{ type: `${mime};charset=utf-8` },
							)
						: await response.blob();
				// one Chrome shows as an image by its URL's extension: a blob:
				// URL names none, and Chrome would show the image in a
				// document, where a data: URL of an image type is an image
				// (Chrome 157: no context, the image's size). Under a policy
				// of the page's that refuses data: the blob: stays. One it
				// shows as an image that is none fails as natively (an
				// embed's error; an object shows the document)
				const shown = usePrototype(
					element,
					CustomElement.prototype,
					imageShown,
				);
				// (one of no type, which Chrome sniffs, is the image)
				const imageMime = IMAGE_TYPE.test(mime) ? mime : !mime && 'image/png';
				// (where the page's own policy allows a data: URL, which the
				// browser's copy of it judges as written)
				const dataAllowed =
					shown &&
					!moduleClient.pageRefusals('object-src', new URL('data:,')).length;
				let url: string | undefined;
				if (shown && !imageMime) {
					if (attribute === 'src')
						url = dataAllowed ? 'data:image/png,' : 'blob:null/failed';
				} else if (shown === 'untyped' && dataAllowed) {
					const bytes = new Uint8Array(await blob.arrayBuffer());
					let binary = '';
					for (let at = 0; at < bytes.length; at += 0x8000)
						binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
					url = `data:${imageMime};base64,${toBase64(binary)}`;
				}
				if (loads.get(element) !== state) return;
				if (current?.url?.startsWith('blob:'))
					realm.URL.revokeObjectURL(current.url);
				settle(url ?? proxyBlobURL(realm.URL.createObjectURL(blob)));
			})
			.catch(() => settle(partless ? null : routed));
	};
	/** whether no copy settled `element`'s load (none made: true) */
	const unsettled = (element: Element) => loads.get(element)?.url === undefined;
	return { heldBlank, typeHook, load, unsettled };
}
