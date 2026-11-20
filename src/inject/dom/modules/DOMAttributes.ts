import {
	restoreCSSValueURLs,
	rewriteCSSValueURLs,
	routeCSS,
} from '../../../cssURLs';
import { handlerMark, keepSource, sourceKey } from '../../../functionSource';
import type { modifyHTML } from '../../../htmlShell';
import { JS_MIME_TYPES } from '../../../prewrite';
import { isXMLDocumentMime, routeHTML } from '../../../rewriteHTML';
import {
	proxyBlobURL,
	ROUTE_PROTOCOLS,
	routeBinary,
	routeImageSet,
	routeXHR,
} from '../../../routeURL';
import { routeJS, ScriptType } from '../../../scriptRoutes';
import { parseAcceptCH } from '../../../server/hintNames';
import { parseSrcset, stringifySrcset } from '../../../srcset';
import {
	dataURLBytes,
	INTEGRITY_MARK,
	markIntegrity,
	NO_INTEGRITY,
	REFUSED_FRAGMENT,
} from '../../../sri';
import StompURL from '../../../StompURL';
import { unresolvable } from '../../../urlShape';
import Module from '../../Module';
import MixedContentModule from '../../modules/MixedContent';
import ProxyModule, { usePrototype } from '../../modules/Proxy';
import { computedURL, scopePrefix, unrouteCSS } from '../../modules/Unroute';
import { LazyMap, LazyWeakMap, LazyWeakSet } from '../../ownCollections';
import { modifyCSS, modifyJS } from '../../rewriter';
import { isParsed } from '../../trusted';
import DocumentClient, {
	addDocumentOpenListener,
	getGlobalParsingState,
	type StyleElement,
} from '../Client';
import {
	inertDocumentOf,
	nativeNodeType,
	nativeQuerySelectorAll,
} from '../cloneNode';
import { ELEMENT_STYLE_INTERFACES } from '../cssRules';
import { deferred } from '../deferred';
import type { DeferredParts } from '../deferredParts';
import { forgetDestination, frameWindow } from '../freshContext';
import { loadFetch } from '../loadGrants';
import { responseURLOf } from '../responseDocuments';
import { guardDocument, realSandbox, sandboxTokens } from '../sandbox';
import { sealerNatives } from '../sealerNatives';
import { siteWindows } from '../siteWindows';
import { SVG_HREF_INTERFACES } from '../svgReferences';
import type { UncontrolledCopies } from '../uncontrolledCopies';
import DOMHooksModule, {
	appliedAttribute,
	CustomElement,
	nativeElement,
	nativeRead,
	pendingAttributes,
} from './DOMHooks';
import {
	hiddenMutation,
	hiddenSuffix,
	isHiddenValue,
	markerPrefix,
	unseenWrite,
} from './MutationObserver';
import NavigationHintModule from './NavigationHint';
import TokenListsModule from './TokenLists';

/**
 * A frame element's container policy as its allow attribute says it, with
 * `allowfullscreen` read as `fullscreen *` where the attribute does not name
 * the feature, as Chrome reads it (empty: neither attribute)
 */
function containerPolicy(element: CustomElement): string {
	// as the page wrote it (the site pool may give the browser another)
	const allow = element.hasAttributeOG('allow')
		? element.getAttributeOG('allow')
		: element.getAttribute('allow');
	if (!element.hasAttribute('allowfullscreen')) return allow ?? '';
	if (allow !== null && /(?:^|;)\s*fullscreen(?:\s|;|$)/i.test(allow))
		return allow;
	return allow ? `${allow}; fullscreen *` : 'fullscreen *';
}

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
/** the name of `element`'s xlink:href, whatever its prefix (x:href), else xlink:href */
const xlinkName = (element: Element): string =>
	(
		Reflect.apply(nativeElement.getAttributeNodeNS, element, [
			XLINK_NAMESPACE,
			'href',
		]) as Attr | null
	)?.name ?? 'xlink:href';

/**
 * What the browser makes of a script element's type, as Chrome does it: a
 * classic script (no type, a JavaScript MIME type in any case or spacing,
 * or the legacy `language` attribute), a module (`module` in any case, no
 * surrounding whitespace), or something that does not run.
 */
export function scriptKind(element: Element): 'classic' | 'module' | null {
	let type = element.getAttribute('type');
	if (type === null) {
		const language = element.getAttribute('language');
		type = language ? `text/${language}` : '';
	}
	if (type.toLowerCase() === 'module') return 'module';
	type = type.trim().toLowerCase();
	if (type === '') return 'classic';
	return JS_MIME_TYPES.has(type) ? 'classic' : null;
}

export function shouldRewriteScript(element: Element) {
	return scriptKind(element) !== null;
}

export function scriptType(element: Element): ScriptType {
	return scriptKind(element) === 'module' ? 'genericModule' : 'generic';
}

export default class DOMAttributesModule extends Module<DocumentClient> {
	formHook?: (element: CustomElement) => void;
	/** @internal whether this document is one no service worker controls, whose routed loads miss the worker */
	uncontrolled: () => boolean = () => false;
	/** @internal copy a <style>'s routed loads in a document no service worker controls (DOMContentHooks) */
	copySheet?: (style: StyleElement, mark: (rule: CSSRule) => void) => void;
	/** @internal copy the routed loads of a sheet whose rules the CSSOM changed, in a document no service worker controls (CSSOM) */
	copyRules?: (sheet: CSSStyleSheet) => void;
	/** @internal copy the routed loads of an element's style that came into a document no service worker controls (DOMContentHooks) */
	copyInline?: (element: Element) => void;
	/** @internal the page's view of a CSSStyleDeclaration: reads unrouted, writes routed (CSSReadback) */
	wrapDeclaration?: (declaration: CSSStyleDeclaration) => CSSStyleDeclaration;
	// captured before the hooks replace them, for serializeStyle
	#nativeStyle: PropertyDescriptor;
	#nativeCssText: PropertyDescriptor;
	// each kind of element that has a declaration has its own getter, which
	// throws "Illegal invocation" on any other kind
	#nativeStyleGetters: (() => CSSStyleDeclaration)[];
	#scratch?: HTMLElement;
	constructor(client: DocumentClient) {
		super(client);
		this.#nativeStyle = Reflect.getOwnPropertyDescriptor(
			client.global.HTMLElement.prototype,
			'style',
		)!;
		this.#nativeStyleGetters = [
			client.global.HTMLElement,
			client.global.SVGElement,
			(client.global as { MathMLElement?: typeof Element }).MathMLElement,
		].flatMap((ctor) => {
			const get = ctor
				? Reflect.getOwnPropertyDescriptor(ctor.prototype, 'style')?.get
				: undefined;
			return get ? [get] : [];
		});
		this.#nativeCssText = Reflect.getOwnPropertyDescriptor(
			client.global.CSSStyleDeclaration.prototype,
			'cssText',
		)!;
	}
	/** an element's own declaration, null for a kind that has none */
	#nativeDeclaration(element: Element): CSSStyleDeclaration | null {
		for (const get of this.#nativeStyleGetters)
			try {
				return Reflect.apply(get, element, []);
			} catch (error) {
				// another kind of element
			}
		return null;
	}
	/** the style attribute the browser writes when `text` is assigned to el.style */
	serializeStyle(text: string): string {
		this.#scratch ??= this.client.global.document.createElement('div');
		Reflect.apply(
			this.#nativeCssText.set!,
			Reflect.apply(this.#nativeStyle.get!, this.#scratch, []),
			[text],
		);
		return nativeElement.getAttribute.call(this.#scratch, 'style') ?? '';
	}
	// (The long loops of this apply run in closures of their own. apply is
	// one call of some 12 KB of bytecode, and a loop in it that ran long
	// enough had V8 compile all of it to baseline code, some 70 KB in each
	// compile of the bundle; with DOMHooks.apply's, the same, a frame of
	// the frame-cost suite paid about 23 KB for it. A loop in a closure has
	// the closure alone compiled.)
	apply() {
		const moduleClient = this.client;
		const realm = moduleClient.global;
		// (the realm's own, as the page may replace it)
		const NativeBlob = realm.Blob;

		/** the page's absolute URL for a routed URL attribute, or false without one */
		const originalURL = (attribute: string) => (element: CustomElement) =>
			element.hasAttribute(attribute) &&
			element.getAttribute(attribute) !== '' &&
			moduleClient
				.encodingParse(
					(element.getAttributeOG(attribute) ??
						element.getAttribute(attribute))!,
					moduleClient.baseHref,
					element,
				)
				.toString();
		/** what the page's URL `value` names, against the document's base */
		const pageURL = (value: string) =>
			moduleClient.atBase(
				moduleClient.encodingParse(value, moduleClient.baseHref),
			);
		/** route one URL attribute, keeping the page's value as the original */
		const routeAttribute =
			(
				attribute: string,
				route: (resource: StompURL) => string,
				// a load (an image, media): copied in a document no worker controls
				load = false,
			) =>
			(element: CustomElement) => {
				element.restoreAttributesOG(attribute);
				if (
					element.hasAttribute(attribute) &&
					element.getAttribute(attribute) !== ''
				) {
					element.setAttributeOG(attribute, element.getAttribute(attribute)!);
					const value = route(pageURL(element.getAttribute(attribute)!));
					if (load) placeLoad(element, attribute, value);
					else element.setAttribute(attribute, value);
				}
			};
		/** originalURL('href') of a link, against its response document's URL (../responseDocuments.ts) */
		const linkURL = (element: CustomElement) =>
			element.hasAttribute('href') &&
			element.getAttribute('href') !== '' &&
			moduleClient
				.encodingParse(
					(element.getAttributeOG('href') ?? element.getAttribute('href'))!,
					responseURLOf(element) ?? moduleClient.baseHref,
					element,
				)
				.toString();

		// A document no service worker controls (an about:blank frame or popup
		// the page built, a document it opened, or a blob: document: Chrome
		// hands none to the page's worker, and an <object>'s HTML document is
		// a blob: copy, since Chrome sends no object load through a worker)
		// loads its elements from the proxy origin's own server,
		// where a route means nothing. Its loads are fetched through the proxy
		// instead (routedFetch, from the nearest controlled ancestor) and the
		// element gets a blob: URL of the copy, written underneath the hooks:
		// the attribute, the property and the markup read back as the page
		// wrote them, currentSrc as the URL the copy came from.
		// (an about:srcdoc document has its parent's worker, so one under such
		// a document has none either. WebKit hands an about:blank document,
		// opened or not, its creator's worker, which serves none of its
		// routes, as it served no document of it: one another realm's bundle
		// made is judged as one with none, measured in the
		// uncontrolled-modules suite)
		const blank = () =>
			moduleClient.opened || realm.location.href === 'about:blank';
		const uncontrolled = () =>
			(realm !== globalThis && blank()) ||
			(!moduleClient.controlled &&
				(blank() ||
					realm.location.href === 'about:srcdoc' ||
					realm.location.protocol === 'blob:'));
		this.uncontrolled = uncontrolled;
		// the proxy origin from the base URL: an about:blank document's own
		// origin reads "null"
		const isRoute = (value: string) => {
			const prefix = scopePrefix(moduleClient);
			try {
				return new URL(value, prefix).href.startsWith(prefix);
			} catch (error) {
				return false;
			}
		};
		// taken now: a page that replaces them later sees none of the copies
		const createObjectURL = realm.URL.createObjectURL;
		const revokeObjectURL = realm.URL.revokeObjectURL;
		const createElement = realm.Document.prototype.createElement;
		const isConnected = Reflect.getOwnPropertyDescriptor(
			realm.Node.prototype,
			'isConnected',
		)!.get!;
		const stopImmediate = realm.Event.prototype.stopImmediatePropagation;
		const nativeQuery = realm.Document.prototype.querySelector;
		// a declaration block's own methods, before the hooks wrap them
		const declarationProto = realm.CSSStyleDeclaration.prototype;
		const nativeDeclaration = {
			setProperty: declarationProto.setProperty,
			getPropertyValue: declarationProto.getPropertyValue,
			getPropertyPriority: declarationProto.getPropertyPriority,
			item: declarationProto.item,
			length: Reflect.getOwnPropertyDescriptor(declarationProto, 'length')!
				.get!,
		};
		const scriptAsync = Reflect.getOwnPropertyDescriptor(
			realm.HTMLScriptElement.prototype,
			'async',
		)?.get;
		/**
		 * The copies, a deferred part (../uncontrolledCopies.ts), made at the
		 * first load such a document copies; none before it
		 */
		let made: UncontrolledCopies | undefined;
		const copier = (): UncontrolledCopies =>
			(made ??= deferred('uncontrolledCopies')({
				moduleClient,
				realm: realm as typeof globalThis,
				NativeBlob,
				uncontrolled,
				isRoute,
				placeLoad,
				sealerNatives,
				sheetMarks,
				natives: {
					createObjectURL,
					revokeObjectURL,
					createElement,
					isConnected,
					nativeDeclaration,
					stopImmediate,
					nativeQuery,
					scriptAsync,
					ruleText,
					nativeRules,
					ruleStyle,
					keyframeStyle,
					ownerNode,
				},
			}));
		/**
		 * A script's or a stylesheet's route with the integrity the page gave
		 * its element: the worker checks the origin's bytes against it, the
		 * element itself keeps none (src/sri.ts)
		 */
		const withIntegrity = (
			element: CustomElement,
			routed: string,
			original?: URL,
		) => {
			// a value the integrity hook has not taken yet is the newest
			const metadata = element.hasAttribute('integrity')
				? element.getAttribute('integrity')
				: element.getAttributeOG('integrity');
			// a data: URL's bytes are here, and checked now: ones that do not
			// match go to the browser as they are, with the page's metadata on
			// the element, and it refuses them itself as natively (its error,
			// its message, a stylesheet with no sheet). Nothing of them runs, so
			// nothing needs rewriting. The digests are a deferred part
			// (src/sriDigest.ts): without it the browser is given an empty
			// data: URL to check instead, which runs nothing (and fails a
			// digest), so the page's own never runs unrewritten
			if (original?.protocol === 'data:' && metadata) {
				const bytes = dataURLBytes(original.href);
				let href = original.href;
				let holds = false;
				try {
					holds = !!bytes && deferred('integrityHoldsSync')(bytes, metadata);
				} catch (error) {
					href = 'data:,';
				}
				if (bytes && !holds) {
					givenIntegrity.add(element);
					element.setAttribute('integrity', metadata);
					element.removeAttributeOG('integrity');
					return href;
				}
			}
			return markIntegrity(routed, metadata, moduleClient.directory);
		};
		/**
		 * Elements the browser is given the page's integrity for (a data: URL
		 * that does not match it, a refused stylesheet asked for again): the
		 * integrity hook leaves the attribute on them, and a new load of theirs
		 * takes it back (releaseIntegrity)
		 */
		const givenIntegrity = new LazyWeakSet<Element>();
		/** before a script or a link routes a new load: the integrity it gave the browser goes back to the page's copy */
		const releaseIntegrity = (element: CustomElement) => {
			if (!givenIntegrity.delete(element)) return;
			if (element.hasAttribute('integrity')) {
				element.setAttributeOG('integrity', element.getAttribute('integrity')!);
				element.removeAttribute('integrity');
			}
		};
		// A stylesheet the worker refused by its integrity fails as a network
		// error, which leaves the link an empty sheet; natively it has none,
		// and document.styleSheets does not list it. Its 'error' is held here,
		// before any listener of the page's, and the link asks for its route
		// again (REFUSED_FRAGMENT) with the page's metadata on it: the worker
		// answers with bytes that fail that metadata (none of the origin's),
		// and the browser refuses them itself, with the error and the console
		// message it gives natively.
		{
			const global = realm as typeof globalThis;
			const targetOf = Reflect.getOwnPropertyDescriptor(
				global.Event.prototype,
				'target',
			)!.get!;
			const localNameOf = Reflect.getOwnPropertyDescriptor(
				global.Element.prototype,
				'localName',
			)!.get!;
			const stop = global.Event.prototype.stopImmediatePropagation;
			const read = nativeElement.getAttribute;
			const write = nativeElement.setAttribute;
			const remove = nativeElement.removeAttribute;
			const held = (event: Event) => {
				if (!event.isTrusted) return;
				const target = Reflect.apply(targetOf, event, []) as Element | null;
				let href: string | null;
				try {
					const name = Reflect.apply(localNameOf, target, []);
					// an object held on about:blank# (see HELD) of a type Chrome
					// knows none of: its copy fires the error, as natively once
					if (name === 'object') {
						if (
							loads.get(target!)?.url === undefined &&
							Reflect.apply(read, target, ['data']) === HELD
						)
							Reflect.apply(stop, event, []);
						return;
					}
					if (name !== 'link') return;
					href = Reflect.apply(read, target, ['href']) as string | null;
				} catch (error) {
					// not an element
					return;
				}
				const rel = (
					(Reflect.apply(read, target, ['rel']) as string | null) ?? ''
				)
					.toLowerCase()
					.split(/[\t\n\f\r ]+/);
				// a link given the page's metadata already: the browser's own
				// refusal (a page's own URL may end in the fragment too)
				if (
					!href ||
					givenIntegrity.has(target!) ||
					!rel.includes('stylesheet') ||
					!href.includes(INTEGRITY_MARK) ||
					href.includes(INTEGRITY_MARK + NO_INTEGRITY)
				)
					return;
				const metadata =
					(Reflect.apply(read, target, [`${markerPrefix()}integrity`]) as
						string | null) ??
					(Reflect.apply(read, target, ['integrity']) as string | null);
				if (metadata === null) return;
				Reflect.apply(stop, event, []);
				const again = href.replace(/#.*$/s, '') + REFUSED_FRAGMENT;
				hiddenMutation(() => {
					Reflect.apply(write, target, ['integrity', metadata]);
					Reflect.apply(remove, target, [`${markerPrefix()}integrity`]);
					// the network error gave the link an empty sheet, which a new
					// load that fails does not take away: no href first
					Reflect.apply(remove, target, ['href']);
					Reflect.apply(write, target, ['href', again]);
				});
				appliedAttribute(target!, 'href', again);
				givenIntegrity.add(target!);
			};
			// opening the document (loadHTML) removes the window's listeners
			const listen = () =>
				Reflect.apply(nativeElement.addEventListener, global, [
					'error',
					held,
					true,
				]);
			listen();
			addDocumentOpenListener(global, listen);
		}
		/**
		 * Set a load attribute to its routed value, or in a document no service
		 * worker controls to a copy of what it names (`urls` maps the value to
		 * the routed URLs it holds, for a srcset; one URL otherwise). The copies
		 * of the value it replaces are released once the new one is set (a
		 * media element plays the old one until then).
		 */
		const placeLoad = (
			element: CustomElement,
			attribute: string,
			routed: string,
			urls: { routed: string; page: string }[] | null = null,
			compose: (copies: string[]) => string = (copies) => copies[0],
			retried = false,
		) => {
			const targets = urls ?? [
				{
					routed,
					page: moduleClient.encodingParse(
						element.getAttributeOG(attribute) ?? routed,
						moduleClient.baseHref,
					).href,
				},
			];
			const perAttribute = made?.copies.get(element);
			const current = perAttribute?.get(attribute);
			if (!uncontrolled() || !targets.some(({ routed }) => isRoute(routed))) {
				element.setAttribute(attribute, routed);
				if (current) {
					perAttribute!.delete(attribute);
					made!.release(current);
				}
				return;
			}
			// its copy (a deferred part): without it the routed value is set,
			// which fails as a failed copy does
			let copies: UncontrolledCopies;
			try {
				copies = copier();
			} catch (error) {
				element.setAttribute(attribute, routed);
				return;
			}
			copies.placeCopy(
				element,
				attribute,
				routed,
				urls,
				compose,
				retried,
				targets,
			);
		};
		const domHooksModule = moduleClient.getModule(DOMHooksModule)!;
		// whether a document in this frame may run scripts: its own sandbox (as
		// the page wrote it, in the marker) and this document's
		const frameRunsScripts = (element: CustomElement) => {
			const sandbox = element.getAttributeOG('sandbox');
			return (
				moduleClient.allows('allow-scripts') &&
				(sandbox === null || sandboxTokens(sandbox).has('allow-scripts'))
			);
		};

		// inline event handler attributes are scripts too: `onclick="top.x()"`
		// would reach the real top. Every `on*` the platform knows about, from
		// the prototypes that carry them; one hook watches them all
		const handlerNames = new Set<string>();
		const g = realm;
		const eachOwner = (owners: object[]) => {
			for (const owner of owners)
				for (const name of Object.getOwnPropertyNames(owner))
					if (/^on[a-z]+$/.test(name)) handlerNames.add(name);
		};
		eachOwner([
			g,
			g.Document.prototype,
			g.HTMLElement.prototype,
			g.SVGElement.prototype,
			g.Element.prototype,
			g.HTMLMediaElement.prototype,
			g.HTMLBodyElement.prototype,
		]);
		// An interface may carry handlers of its own (an SVG animation's
		// onbegin, onend and onrepeat, a video's picture-in-picture ones, the
		// permission elements'), and a name the hooks did not know ran its
		// attribute as the page wrote it. So the hook watches every `on*`
		// name, and one outside the set above is a handler where an element of
		// that name has its property: asked of a fresh element in the inert
		// document (the hooks run with the element's own prototype set aside),
		// once per element name, so no interface is made in a frame for a name
		// its page never writes. A custom element's own property makes no
		// handler of its attribute.
		const createElementNS = g.Document.prototype.createElementNS;
		const ownHandlers = new LazyMap<string, boolean>();
		const isHandler = (element: Element, name: string): boolean => {
			if (handlerNames.has(name)) return true;
			const namespace = element.namespaceURI;
			const localName = element.localName;
			if (localName.includes('-')) return false;
			const key = `${namespace} ${localName} ${name}`;
			let known = ownHandlers.get(key);
			if (known === undefined) {
				try {
					known =
						name in
						(Reflect.apply(createElementNS, inertDocumentOf(g.document), [
							namespace,
							localName,
						]) as Element);
				} catch (error) {
					// no element of that name: no handler either
					known = false;
				}
				ownHandlers.set(key, known);
			}
			return known;
		};
		class HandlerNames extends Set<string> {
			override has(name: string) {
				return /^on[a-z]+$/.test(name);
			}
		}
		domHooksModule.useAttributes(
			(element, name) => {
				if (!isHandler(element, name)) return;
				element.restoreAttributesOG(name);
				if (element.hasAttribute(name)) {
					const source = element.getAttribute(name)!;
					element.setAttributeOG(name, source);
					// the page's own script-src-attr refuses this inline handler: it
					// compiles nothing (no browser-facing attribute) and the inject
					// reports it (src/csp.ts)
					if (moduleClient.refuseHandler(element, source)) {
						// clear the live handler (the page's own, which the page's
						// setAttribute left on the element) so clicking runs nothing
						element.removeAttribute(name);
						element.removeAttributeOG(name);
						return;
					}
					// the browser compiles the code as a function's body: marked,
					// so the function reads back with the page's code in it
					const key = sourceKey(source);
					keepSource(key, source);
					element.setAttribute(
						name,
						handlerMark(key) +
							modifyJS(
								source,
								moduleClient.baseURL,
								moduleClient.config,
								'generic',
							),
					);
				}
			},
			[['*', new HandlerNames()]],
		);

		// SVG references (sprites, images, filters) by href or legacy
		// xlink:href. SVG node names keep their case, and the fragment stays.
		// The ones that load another file (an <image>, a <use> of an external
		// sprite, an <feImage>) are copied in a document no worker controls,
		// the fragment kept on the copy
		const SVG_LOADS = ['image', 'use', 'feimage'];
		// (each is called with the attribute's own name: an xlink:href by
		// another prefix, x:href, is the same attribute)
		const svgHook = (element: CustomElement, attribute: string) => {
			element.restoreAttributesOG(attribute);
			if (!element.hasAttribute(attribute)) return;
			const value = element.getAttribute(attribute)!;
			if (value === '' || value.startsWith('#')) return;
			element.setAttributeOG(attribute, value);
			const routed = routeBinary(pageURL(value));
			if (SVG_LOADS.includes(element.localName.toLowerCase()))
				placeLoad(element, attribute, routed);
			else element.setAttribute(attribute, routed);
		};
		for (const attribute of ['href', 'xlink:href'])
			domHooksModule.useAttributes(
				svgHook,
				// live SVG elements keep their case; the page loader clones them as
				// HTML elements first, whose nodeName is upper case
				[
					'use',
					'image',
					'feImage',
					'mpath',
					'textPath',
					'linearGradient',
					'radialGradient',
					'pattern',
					'filter',
					'animate',
					'animateMotion',
					'animateTransform',
					'set',
					'cursor',
					'tref',
				]
					.flatMap((tag) => [tag, tag.toUpperCase()])
					.map((tag): [string, string] => [tag, attribute]),
			);

		// an SVG script loads its source by href (or xlink:href), like src
		const svgScriptHook = (element: CustomElement, attribute: string) => {
			element.restoreAttributesOG(attribute);
			if (!element.hasAttribute(attribute)) return;
			const value = element.getAttribute(attribute)!;
			if (value === '') return;
			element.setAttributeOG(attribute, value);
			const routed = routeJS(
				pageURL(value),
				moduleClient.baseURL,
				moduleClient.config,
				'generic',
			);
			// an HTML script's href loads nothing
			if (element.namespaceURI === SVG_NAMESPACE)
				placeLoad(element, attribute, routed);
			else element.setAttribute(attribute, routed);
		};
		for (const attribute of ['href', 'xlink:href'])
			domHooksModule.useAttributes(svgScriptHook, [
				['script', attribute],
				['SCRIPT', attribute],
			]);

		// the values the animations' hooks routed, by route: what an animated
		// href's animVal reads back
		const animatedValues = new Map<string, string>();
		// an SVG reference's `href` is an SVGAnimatedString: its baseVal and
		// animVal read the attribute the page wrote (the hooked getAttribute),
		// setting baseVal writes through the hooked setAttribute, so it routes
		{
			const proxyModule = moduleClient.getModule(ProxyModule)!;
			const global = realm as unknown as Record<string, any>;
			const owners = new LazyWeakMap<object, Element>();
			for (const name of SVG_HREF_INTERFACES) {
				const prototype = global[name]?.prototype;
				const descriptor =
					prototype && Reflect.getOwnPropertyDescriptor(prototype, 'href');
				if (!descriptor?.get) continue;
				Reflect.defineProperty(prototype, 'href', {
					...descriptor,
					get: proxyModule.wrapFunction(
						descriptor.get,
						(target, that, args) => {
							const value = Reflect.apply(target, that, args);
							if (value && typeof value === 'object') owners.set(value, that);
							return value;
						},
					),
				});
			}
			const animated = global.SVGAnimatedString?.prototype;
			const createSVG = global.Document.prototype.createElementNS;
			const routedBases = new WeakMap<Element, [string, string]>();
			const baseGet =
				animated && Reflect.getOwnPropertyDescriptor(animated, 'baseVal')?.get;
			if (animated)
				for (const property of ['baseVal', 'animVal']) {
					const descriptor = Reflect.getOwnPropertyDescriptor(
						animated,
						property,
					);
					if (!descriptor?.get) continue;
					Reflect.defineProperty(animated, property, {
						...descriptor,
						get: proxyModule.wrapFunction(
							descriptor.get,
							(target, that, args) => {
								const owner = owners.get(that);
								if (!owner) return Reflect.apply(target, that, args);
								// an animation running on the href: the value it set,
								// as the page wrote it (animatedValues)
								if (property === 'animVal' && baseGet) {
									const live = Reflect.apply(target, that, args) as string;
									if (live !== Reflect.apply(baseGet, that, []))
										return animatedValues.get(live) ?? live;
								}
								// a baseVal set where only an xlink:href is (below)
								const set = routedBases.get(owner);
								if (
									set &&
									baseGet &&
									Reflect.apply(baseGet, that, []) === set[0]
								)
									return set[1];
								return (
									owner.getAttribute(
										owner.hasAttribute('href') ? 'href' : xlinkName(owner),
									) ?? ''
								);
							},
						),
						set: descriptor.set
							? proxyModule.wrapFunction(
									descriptor.set,
									(target, that, args) => {
										const owner = owners.get(that);
										if (!owner) return Reflect.apply(target, that, args);
										const value = String(args[0]);
										if (
											!owner.hasAttribute('href') &&
											owner.hasAttribute(xlinkName(owner))
										) {
											// where only an xlink:href is, Chrome sets the
											// property alone: the attribute reads as it was and
											// the element loads the new value, routed as on an
											// element of its kind (made where nothing loads)
											const scratch = Reflect.apply(
												createSVG,
												inertDocumentOf(realm.document),
												['http://www.w3.org/2000/svg', owner.localName],
											) as Element;
											scratch.setAttribute('href', value);
											const routed =
												nativeElement.getAttribute.call(scratch, 'href') ?? '';
											routedBases.set(owner, [routed, value]);
											return Reflect.apply(target, that, [routed]);
										}
										owner.setAttribute('href', value);
									},
								)
							: undefined,
					});
				}
		}

		// browsing context names that would leave the frame: a top-level page
		// navigates itself for these, so does a proxied one. `_blank` and
		// names stay native (popups) until a host opts into onOpen
		// A sandboxed document's are left as written: the real frame's sandbox
		// never allows top navigation, so the browser refuses them as it
		// would natively, and the Sandbox module navigates the proxied top for
		// a link the page's sandbox lets through
		// (a frame under the proxied top is navigated the same way, and the
		// hooks navigate the proxied parent or top it means: DocumentClient
		// targetWindow)
		const selfTargets = ['_top', '_parent', '_unfencedtop'];
		const targetHook = (attribute: string) => (element: CustomElement) => {
			element.restoreAttributesOG(attribute);
			if (!element.hasAttribute(attribute)) return;
			const value = element.getAttribute(attribute)!;
			if (!selfTargets.includes(value.toLowerCase())) return;
			if (moduleClient.sandboxFlags !== null) return;
			element.setAttributeOG(attribute, value);
			element.setAttribute(attribute, '_self');
		};
		const ogOrFalse = (attribute: string) => (element: CustomElement) =>
			element.getAttributeOG(attribute) ?? false;
		domHooksModule.useAttributes(targetHook('target'), [
			['A', 'target'],
			['AREA', 'target'],
			['FORM', 'target'],
			['BASE', 'target'],
			[realm.HTMLAnchorElement, 'target', ogOrFalse('target')],
			[realm.HTMLAreaElement, 'target', ogOrFalse('target')],
			[realm.HTMLFormElement, 'target', ogOrFalse('target')],
			[realm.HTMLBaseElement, 'target', ogOrFalse('target')],
		]);
		domHooksModule.useAttributes(targetHook('formtarget'), [
			['BUTTON', 'formtarget'],
			['INPUT', 'formtarget'],
			[realm.HTMLButtonElement, 'formTarget', ogOrFalse('formtarget')],
			[realm.HTMLInputElement, 'formTarget', ogOrFalse('formtarget')],
		]);

		// <iframe srcdoc>: the inline document gets the same shell a fetched
		// one gets, with this page as its base
		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('srcdoc');
				if (element.hasAttribute('srcdoc')) {
					const source = element.getAttribute('srcdoc')!;
					// the shell is a deferred part: without it the frame gets no
					// srcdoc at all, never the page's markup unrewritten
					let shell: typeof modifyHTML;
					try {
						shell = deferred('modifyHTML');
					} catch (error) {
						element.removeAttribute('srcdoc');
						return;
					}
					element.setAttributeOG('srcdoc', source);
					element.setAttribute(
						'srcdoc',
						shell(
							source,
							moduleClient.baseURL,
							moduleClient.config,
							false,
							undefined,
							moduleClient.scriptNonce,
						),
					);
				}
			},
			[
				['IFRAME', 'srcdoc'],
				[realm.HTMLIFrameElement, 'srcdoc', ogOrFalse('srcdoc')],
			],
		);

		const linkHook = (element: CustomElement, attribute: string) => {
			element.restoreAttributesOG(attribute);

			if (
				element.hasAttribute(attribute) &&
				element.getAttribute(attribute) !== ''
			) {
				element.setAttributeOG(attribute, element.getAttribute(attribute)!);
				element.setAttribute(
					attribute,
					moduleClient.linkRoute(pageURL(element.getAttribute(attribute)!)),
				);
			}
		};
		// an SVG link's legacy xlink:href is a link as much as its href: a
		// javascript: URL in it ran as the page wrote it
		domHooksModule.useAttributes(linkHook, [['a', 'xlink:href']]);
		// An SVG animation of a link's href (<set attributeName="href"
		// to="javascript:...">, <animate values="...">) makes its values the
		// link's while it runs: they are routed the way the attribute itself
		// is, the link's as a link (which rewrites a javascript: URL's code),
		// any other reference's as the file it loads. The animation's target is
		// the element its own href names, else its parent; a value written
		// before either is known (the element its href names appears later,
		// and SMIL finds it then) is routed as a file, which is what an image
		// or a use takes (a link that takes it navigates to the file); a
		// javascript: URL as a link's always (no reference runs one
		// unrewritten). The attribute is href by any prefix: the browser
		// looks the prefix up (q:href, with q bound to xlink), and a prefix
		// it finds no namespace for animates nothing, whatever its values.
		// A change of the animation's own href retargets it: routed again.
		const ANIMATED = ['to', 'from', 'by', 'values'];
		const animatedTarget = (element: CustomElement): Element | null => {
			const reference =
				element.getAttribute('href') ??
				element.getAttribute(xlinkName(element));
			if (reference?.startsWith('#'))
				return (
					(element.getRootNode() as Document | ShadowRoot).getElementById?.(
						reference.slice(1),
					) ?? null
				);
			return element.parentElement;
		};
		const animatedHook = (element: CustomElement) => {
			element.restoreAttributesOG(...ANIMATED);
			const name = element.getAttribute('attributeName');
			if (name === null || !/^(?:[^:]+:)?href$/.test(name)) return;
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
		};
		domHooksModule.useAttributes(
			animatedHook,
			['set', 'animate'].flatMap((tag) =>
				[...ANIMATED, 'attributeName', 'href', 'xlink:href'].map(
					(attribute): [string, string] => [tag, attribute],
				),
			),
		);

		domHooksModule.useAttributes(
			linkHook,
			[
				['A', 'href'],
				['a', 'href'],
				['AREA', 'href'],
				[realm.HTMLAnchorElement, 'href', linkURL],
				// an image map's areas are links too
				[realm.HTMLAreaElement, 'href', linkURL],
			],
			// URL attributes do not mixin with element attributes
		);

		domHooksModule.useAttributes(
			(element, attribute) => {
				// the browser reads a script's integrity when it starts the load,
				// at its insertion: a connected one keeps the load it has
				if (attribute === 'integrity' && element.isConnected) return;
				releaseIntegrity(element);
				element.restoreAttributesOG('src');
				// a held script (holdScript) keeps its page's src through a change
				// of its type or integrity (its route, integrity and all, is made
				// as it connects); a src set or removed again replaces it
				if (moduleClient.scriptsHeld && moduleClient.scriptHeld(element)) {
					if (attribute === 'type' || attribute === 'integrity') return;
					moduleClient.releaseScript(element);
				}

				if (
					element.hasAttribute('src') &&
					element.getAttribute('src') !== '' &&
					shouldRewriteScript(element)
				) {
					element.setAttributeOG('src', element.getAttribute('src')!);
					const url = moduleClient.encodingParse(
						element.getAttribute('src')!,
						moduleClient.baseHref,
					);
					// the page's own script-src refuses this external script: it
					// does not load, the browser fires 'error', and the inject
					// reports it (src/csp.ts). A script the page inserts through the
					// DOM, not the parser (DOMAttributes runs for inserted elements).
					// One not connected yet that a nonce could still let through is
					// held refused, and judged again as it connects, as Chrome
					// judges it (with the nonce it has then: DOMContentHooks). One of
					// markup the parser runs (a copy made of it) is the parser's:
					// a document.write's is judged now; the page's markup gets no
					// src here where the policies in force refuse it (more
					// policies refuse no less), and is judged and reported as the
					// parser prepares it, by the policies in force then
					// (judgeParsed), in its order
					const parser =
						isParsed(element) &&
						getGlobalParsingState(realm) === 'parsingBeforeWrite';
					if (
						!parser &&
						!element.isConnected &&
						moduleClient.scriptAwaitsNonce(element, url)
					) {
						const src = element.getAttribute('src')!;
						element.removeAttribute('src');
						element.removeAttributeOG('src');
						moduleClient.holdScript(element, url, src);
						return;
					}
					if (parser && moduleClient.markupCopy)
						moduleClient.quietRefusal = true;
					let refused: boolean;
					try {
						refused = moduleClient.refuseExternalScript(element, url, parser);
					} finally {
						moduleClient.quietRefusal = false;
					}
					if (refused) {
						// the parser's keeps the page's src and gets an empty one,
						// for which the browser fires its error as it prepares it
						if (parser) {
							element.setAttribute('src', '');
							return;
						}
						// clear the live src (the page's own, which the browser would
						// otherwise load) so nothing loads; the browser fires 'error'
						element.removeAttribute('src');
						element.removeAttributeOG('src');
						moduleClient.dispatchLoadError(element);
						return;
					}
					// let through by its host or its integrity where the page's
					// policy says so and the browser's copy would not (src/csp.ts)
					moduleClient.giveCodeNonce(element, url, null, parser);
					placeLoad(
						element,
						'src',
						withIntegrity(
							element,
							routeJS(
								new StompURL(url, moduleClient.baseURL),
								moduleClient.baseURL,
								moduleClient.config,
								scriptType(element),
							),
							url,
						),
					);
				}
			},
			[
				['SCRIPT', 'src'],
				// the route depends on type=module, which pages may set after src
				['SCRIPT', 'type'],
				// and carries the integrity (src/sri.ts), which may come after src
				['SCRIPT', 'integrity'],
				[realm.HTMLScriptElement, 'integrity', nativeRead],
				[realm.HTMLScriptElement, 'src', originalURL('src')],
			],
		);

		domHooksModule.useAttributes(
			(element) => {
				// the browser checks this one itself (withIntegrity)
				if (givenIntegrity.has(element)) return;
				element.restoreAttributesOG('integrity');

				if (element.hasAttribute('integrity')) {
					element.setAttributeOG(
						'integrity',
						element.getAttribute('integrity')!,
					);
					element.removeAttribute('integrity');
				}
			},
			[
				['LINK', 'integrity'],
				['SCRIPT', 'integrity'],
				// the page's value: the element itself has none (the browser
				// would check the rewrite against it)
				[realm.HTMLLinkElement, 'integrity', ogOrFalse('integrity')],
				[realm.HTMLScriptElement, 'integrity', ogOrFalse('integrity')],
			],
		);

		domHooksModule.useAttributes(
			(element, attribute) => {
				// a stylesheet's integrity is read when its load starts: a
				// connected link keeps the load it has (as natively)
				if (attribute === 'integrity' && element.isConnected) return;
				releaseIntegrity(element);
				element.restoreAttributesOG('href');

				if (
					element.hasAttribute('href') &&
					element.hasAttribute('rel') &&
					element.getAttribute('href') !== ''
				) {
					// rel is a token list; a preload's route follows `as`
					const rel = new Set(
						element.getAttribute('rel')!.trim().toLowerCase().split(/\s+/),
					);
					const as = (element.getAttribute('as') || '').trim().toLowerCase();
					const resource = pageURL(element.getAttribute('href')!);
					element.setAttributeOG('href', element.getAttribute('href')!);
					const stylesheet =
						rel.has('stylesheet') ||
						((rel.has('preload') || rel.has('prefetch')) && as === 'style');
					if (rel.has('manifest')) element.removeAttribute('href');
					// the page's own style-src refuses this external stylesheet: it
					// does not load, the browser fires 'error', the inject reports it
					else if (
						stylesheet &&
						moduleClient.refuseExternalStyle(
							element,
							moduleClient.encodingParse(
								element.getAttribute('href')!,
								moduleClient.baseHref,
							),
						)
					) {
						element.removeAttribute('href');
						element.removeAttributeOG('href');
						moduleClient.dispatchLoadError(element);
					} else if (stylesheet)
						placeLoad(
							element,
							'href',
							withIntegrity(
								element,
								routeCSS(resource, moduleClient.baseURL),
								resource.url,
							),
						);
					else if (rel.has('modulepreload'))
						placeLoad(
							element,
							'href',
							withIntegrity(
								element,
								routeJS(
									resource,
									moduleClient.baseURL,
									moduleClient.config,
									'genericModule',
								),
							),
						);
					else if (
						(rel.has('preload') || rel.has('prefetch')) &&
						as === 'script'
					)
						placeLoad(
							element,
							'href',
							withIntegrity(
								element,
								routeJS(
									resource,
									moduleClient.baseURL,
									moduleClient.config,
									'generic',
								),
							),
						);
					else placeLoad(element, 'href', routeBinary(resource));
				}
			},
			[
				['LINK', 'href'],
				['LINK', 'rel'],
				['LINK', 'as'],
				// the route carries the integrity (src/sri.ts), which markup and
				// pages may give after href
				['LINK', 'integrity'],
				[realm.HTMLLinkElement, 'integrity', nativeRead],
				[realm.HTMLLinkElement, 'as', nativeRead],
				[realm.HTMLLinkElement, 'href', linkURL],
				[realm.HTMLLinkElement, 'rel', nativeRead],
			],
		);

		// todo: mimes...?
		// https://www.w3schools.com/tags/tag_embed.asp

		/**
		 * The origin of the document a frame shows now ('null' for an opaque
		 * one), or undefined when it has no context yet (not connected) or
		 * shows a document of another real origin (the host's)
		 */
		const frameOrigin = (element: Element): string | undefined => {
			const shown = frameWindow(element);
			if (!shown) return undefined;
			try {
				const client = (shown as unknown as Record<string, unknown>)[
					moduleClient.names.client
				] as DocumentClient | undefined;
				if (client?.isDOM) return client.originKey ?? 'null';
				// its initial about:blank, which nothing injected yet: of this
				// document's origin
				if (shown.location.href === 'about:blank')
					return moduleClient.originKey ?? 'null';
			} catch (error) {
				// a document of another real origin
			}
			return undefined;
		};

		const contentWindowOf = Reflect.getOwnPropertyDescriptor(
			realm.HTMLIFrameElement.prototype,
			'contentWindow',
		)!.get!;
		// a slot of the site pool: the browser reads the frame's allow for a
		// document of another origin (../siteEvents.ts slotContainerPolicy), the page its own;
		// before the frame is navigated too, since the browser takes the
		// container policy with the navigation
		// The property reads the page's attribute through a hook made the
		// first time a frame's attribute is changed: until then the native
		// getter reads what the page wrote, and a frame that never has an
		// allow attribute (most) makes no wrappers for it
		let allowRead = false;
		// (made only under a pool)
		const slotAllow: ((element: CustomElement) => void) | null = !this.client
			.sites
			? null
			: (element) => {
					if (element.nodeName !== 'IFRAME') return;
					element.restoreAttributesOG('allow');
					if (!element.hasAttribute('allow')) return;
					const allow = element.getAttribute('allow')!;
					if (!allowRead) {
						allowRead = true;
						domHooksModule.useAttributes(slotAllow!, [
							[
								this.client.global.HTMLIFrameElement,
								'allow',
								ogOrFalse('allow'),
							],
						]);
					}
					element.setAttributeOG('allow', allow);
					element.setAttribute('allow', deferred('slotContainerPolicy')(allow));
				};
		if (slotAllow)
			domHooksModule.useAttributes(slotAllow, [['IFRAME', 'allow']]);
		domHooksModule.useAttributes(
			(element, attribute) => {
				// Chrome takes a frame's credentialless attribute at its next
				// navigation: one in a document is not sent again for it
				if (attribute === 'credentialless' && element.isConnected) return;
				element.restoreAttributesOG('src');

				if (element.hasAttribute('src') && element.getAttribute('src') !== '') {
					element.setAttributeOG('src', element.getAttribute('src')!);
					const resource = pageURL(element.getAttribute('src')!);
					// a javascript: URL runs in the frame, which a sandbox without
					// allow-scripts forbids: natively nothing happens, so the frame
					// is not navigated at all
					if (
						resource.url.protocol === 'javascript:' &&
						!frameRunsScripts(element)
					) {
						element.removeAttribute('src');
						return;
					}
					// a data: document's frame is a deferred part (an opaque
					// document, ../rareAttributes.ts), made first: without it the
					// frame is not navigated, never to the page's markup
					// unrewritten
					let opaqueDocument: DeferredParts['opaqueDocument'] | undefined;
					if (resource.url.protocol === 'data:')
						try {
							opaqueDocument = deferred('opaqueDocument');
						} catch (error) {
							moduleClient.opaqueFrames.delete(element);
							element.removeAttribute('src');
							return;
						}
					// the page's frame-src (src/csp.ts): a frame its policy
					// refuses is sent where the browser's copy of the policy
					// refuses it, and the browser refuses and reports it as natively
					const refused = moduleClient.loadRefusal(
						'frame-src',
						resource.url,
						true,
					);
					if (refused !== null) {
						moduleClient.opaqueFrames.delete(element);
						element.setAttribute('src', refused);
						return;
					}
					const opaque =
						opaqueDocument?.(moduleClient, resource, NativeBlob) ?? null;
					if (opaque) moduleClient.opaqueFrames.add(element);
					else moduleClient.opaqueFrames.delete(element);
					// the frame navigates for this document, under its activation,
					// with its element's allow attribute as its container policy
					// (the worker's client hints and permissions policy for the
					// frame read it; empty when the element has none),
					// `allowfullscreen` being `fullscreen *` where the attribute
					// does not name the feature; and with what judges the frame's
					// later hops and the document it ends in: this document's
					// frame-src, and the frame's real ancestors (src/csp.ts)
					if (!opaque)
						moduleClient
							.getModule(NavigationHintModule)
							?.hint(
								resource.url.href,
								element.nodeName === 'IFRAME'
									? containerPolicy(element)
									: undefined,
								{
									policies: moduleClient.hopPolicies('frame-src') ?? [],
									ancestors: [
										moduleClient.origin,
										...moduleClient.ancestorOrigins(),
									],
									required: moduleClient.requiredCSP(element),
								},
							);
					const routed =
						opaque ??
						routeHTML(
							resource,
							moduleClient.baseURL,
							moduleClient.config,
							false,
							// the route says whether the frame is a credentialless
							// one (its partition's nonce; the attribute itself is
							// kept from the browser, below), and with the host's
							// page cross-origin isolated whom the frame's `allow`
							// lets be (the site pool: and the frame's sandbox,
							// which a frame of another slot cannot read)
							moduleClient.childRouteFor(
								moduleClient.hostIsolated
									? element.hasAttributeOG('allow')
										? element.getAttributeOG('allow')
										: element.getAttribute('allow')
									: null,
								moduleClient.hostIsolated ? resource.url.origin : null,
								// (only where the browser has credentialless frames:
								// elsewhere the attribute is nothing to it)
								'credentialless' in realm.HTMLIFrameElement.prototype &&
									(element.hasAttributeOG('credentialless') ||
										element.hasAttribute('credentialless')),
								moduleClient.sites
									? siteWindows().frameSandbox(moduleClient, element)
									: null,
							),
						);
					// a frame that shows a document of another origin than the
					// one it is sent to gets a fresh browsing context first
					// (freshContext.ts): a window the page reached while the
					// frame was of its origin must not show the next one. Its
					// initial about:blank is this document's origin, and fires no
					// navigate event of its own (IFrame)
					forgetDestination(moduleClient, element);
					const shown = frameOrigin(element);
					if (
						shown !== undefined &&
						shown !== (opaque ? 'null' : resource.url.origin) &&
						resource.url.protocol !== 'javascript:' &&
						resource.url.href !== 'about:blank' &&
						moduleClient.freshFrame
					) {
						if (moduleClient.freshFrame(element, routed)) return;
					}
					// the document the frame shows now sees the navigation (its
					// navigate event): this one judged it
					try {
						const shown = (
							Reflect.apply(contentWindowOf, element, []) as Record<
								string,
								unknown
							> | null
						)?.[moduleClient.names.client] as DocumentClient | undefined;
						const hints = shown?.getModule?.(NavigationHintModule);
						if (hints) hints.judged = resource.url.href.replace(/#.*$/s, '');
					} catch (error) {
						// a document of another origin, or none
					}
					slotAllow?.(element);
					element.setAttribute('src', routed);
				}
			},
			[
				['IFRAME', 'src'],
				['FRAME', 'src'],
				// what the route says of the frame (`allow`: an isolated host only)
				['IFRAME', 'credentialless'],
				...(moduleClient.hostIsolated
					? ([['IFRAME', 'allow']] as [string, string][])
					: []),
				[realm.HTMLFrameElement, 'src', originalURL('src')],
				[realm.HTMLIFrameElement, 'src', originalURL('src')],
			],
		);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('content');

				if (
					element.hasAttribute('content') &&
					element.getAttribute('content') !== ''
				)
					switch (element.getAttribute('http-equiv')?.toLowerCase()) {
						// the page's policy as the browser can apply it to the
						// proxy's URLs (src/csp.ts); it applies when the meta is
						// inserted, as natively
						case 'content-security-policy': {
							const content = element.getAttribute('content')!;
							element.setAttributeOG('content', content);
							const policy = moduleClient.metaPolicy(content);
							if (policy === null) element.removeAttribute('content');
							else element.setAttribute('content', policy);
							break;
						}
						// client hints are the worker's to send for the real
						// origins (src/server/clientHints.ts, which reads a
						// page's own metas from its markup): the browser must
						// not apply them to the proxy origin
						case 'accept-ch':
						case 'delegate-ch': {
							const content = element.getAttribute('content')!;
							element.setAttributeOG('content', content);
							element.removeAttribute('content');
							// one the page's script inserts counts for its later
							// requests; a scripted delegate-ch counts for nothing
							// (measured)
							if (
								element.getAttribute('http-equiv')!.toLowerCase() ===
								'accept-ch'
							)
								moduleClient.reportAcceptCH(parseAcceptCH(content) ?? []);
							break;
						}
						// a deferred part (../rareAttributes.ts), made first:
						// without it the meta has no content for the browser
						case 'refresh': {
							let refresh: DeferredParts['metaRefresh'];
							try {
								refresh = deferred('metaRefresh');
							} catch (error) {
								element.removeAttribute('content');
								break;
							}
							refresh(moduleClient, element);
							break;
						}
					}
			},
			[
				['META', 'content'],
				['META', 'http-equiv'],
				[
					realm.HTMLMetaElement,
					'content',
					// what the page wrote, for a refresh the hook rewrote; any
					// other content (a token, a payload) is not a URL and reads
					// natively
					ogOrFalse('content'),
				],
				[realm.HTMLMetaElement, 'httpEquiv', nativeRead],
			],
		);

		domHooksModule.useAttributes(routeAttribute('src', routeBinary, true), [
			['IMG', 'src'],
			['INPUT', 'src'],
			[realm.HTMLInputElement, 'src', originalURL('src')],
			[realm.HTMLImageElement, 'src', originalURL('src')],
		]);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('srcset');

				if (
					element.hasAttribute('srcset') &&
					element.getAttribute('srcset') !== ''
				) {
					element.setAttributeOG('srcset', element.getAttribute('srcset')!);

					const parsed = parseSrcset(element.getAttribute('srcset')!);
					const updated: { url: string; width?: number; density?: number }[] =
						[];

					// a candidate that is no URL (`https://[`) stays as written: the
					// browser keeps it in the list and fails it if it picks it
					const pages = parsed.map((src) => {
						try {
							return moduleClient.encodingParse(src.url, moduleClient.baseHref);
						} catch (error) {
							return null;
						}
					});
					parsed.forEach((src, index) => {
						const page = pages[index];
						updated.push({
							...src,
							url: page ? routeImageSet(moduleClient.atBase(page)) : src.url,
						});
					});

					placeLoad(
						element,
						'srcset',
						stringifySrcset(updated),
						updated.map((candidate, index) => ({
							routed: candidate.url,
							page: pages[index]?.href ?? parsed[index].url,
						})),
						(copied) =>
							stringifySrcset(
								updated.map((candidate, index) => ({
									...candidate,
									url: copied[index],
								})),
							),
					);
				}
			},
			[
				['IMG', 'srcset'],
				['SOURCE', 'srcset'],
				[
					realm.HTMLImageElement,
					'srcset',
					(element) =>
						element.hasAttribute('srcset') &&
						element.getAttribute('srcset') !== '' &&
						(element.getAttributeOG('srcset') ??
							element.getAttribute('srcset'))!,
				],
				[
					realm.HTMLSourceElement,
					'srcset',
					(element) =>
						element.hasAttribute('srcset') &&
						element.getAttribute('srcset') !== '' &&
						(element.getAttributeOG('srcset') ??
							element.getAttribute('srcset'))!,
				],
			],
		);

		domHooksModule.useAttributes(routeAttribute('src', routeBinary, true), [
			['AUDIO', 'src'],
			['VIDEO', 'src'],
			['SOURCE', 'src'],
			['TRACK', 'src'],
			[realm.HTMLTrackElement, 'src', originalURL('src')],
			[realm.HTMLMediaElement, 'src', originalURL('src')],
			[realm.HTMLSourceElement, 'src', originalURL('src')],
		]);

		// An element's inline style in a document no service worker controls:
		// once a write settles (the attribute, a CSSOM write), its routes are
		// copied and the copies set underneath the hooks, owned by the element.
		// Set up with the declaration hooks below.
		let copyInlineSoon: (element: Element) => void = () => {};

		domHooksModule.useAttributes(
			(element) => {
				// our rewritten text comes back serialized by the browser when the
				// page assigns it to el.style (Polymer does, from
				// attributeChangedCallback for the attribute we just wrote). Taken
				// as a new value it would flip the attribute between the original
				// and the rewritten text forever, which froze YouTube
				const current = element.getAttribute('style');

				if (current !== null && element.hasAttributeOG('style')) {
					const rewritten = modifyCSS(
						(element.getAttributeOG('style') ?? element.getAttribute('style'))!,
						moduleClient.baseURL,
						'declarationList',
					);

					if (
						current === rewritten ||
						current === this.serializeStyle(rewritten)
					)
						return;
				}

				element.restoreAttributesOG('style');

				if (
					element.hasAttribute('style') &&
					element.getAttribute('style') !== ''
				) {
					// (the page's style-src-attr refuses a style attribute the page
					// sets as a string: enforced at the setAttribute hook, not here,
					// so a CSSOM write that serialises into the attribute, which the
					// browser does not refuse, is not caught, src/inject/dom/
					// modules/DOMHooks.ts)
					// a style the browser serialised from a CSSOM write (a copy of
					// such an element, inserted) holds routes: the page's is the
					// browser's serialisation of the url()s it wrote
					element.setAttributeOG(
						'style',
						unrouteCSS(moduleClient, element.getAttribute('style')!, true),
					);
					element.setAttribute(
						'style',
						modifyCSS(
							(element.getAttributeOG('style') ??
								element.getAttribute('style'))!,
							moduleClient.baseURL,
							'declarationList',
						),
					);
				}
				copyInlineSoon(element);
			},
			[
				['*', 'style'],
				[realm.HTMLElement, 'style', nativeRead],
			],
		);

		// CSSStyleDeclaration: element.style.x = ..., setProperty(), cssText
		{
			const styleProto = realm.CSSStyleDeclaration.prototype;
			const proxyModule = moduleClient.getModule(ProxyModule)!;

			// the element each page-facing declaration belongs to
			const owners = new LazyWeakMap<CSSStyleDeclaration, Element>();
			const pending = new LazyWeakSet<Element>();
			copyInlineSoon = (element) => {
				if (!uncontrolled() || pending.has(element)) return;
				pending.add(element);
				queueMicrotask(() => {
					pending.delete(element);
					const declaration = this.#nativeDeclaration(element);
					// no declaration, no style: nothing loads
					if (!declaration) return;
					try {
						copier().copyInline(element, declaration);
					} catch (error) {
						// the part cannot be had: the style's loads stay routed
					}
				});
			};
			// A CSSOM write makes the browser serialise the declaration into the
			// attribute, so what the page wrote as the attribute (its marker)
			// is no longer what the attribute holds: it goes, and the attribute
			// reads as the browser serialised it, with the page's url()s
			const dropMarker = (element: Element) => {
				// most writes: no marker to drop, known without a prototype swap
				if (
					!pendingAttributes(element) &&
					!nativeElement.hasAttribute.call(element, `${markerPrefix()}style`)
				)
					return;
				usePrototype(element, CustomElement.prototype, (element) => {
					if (element.hasAttributeOG('style'))
						element.removeAttributeOG('style');
				});
			};
			// a rule's declarations (rule.style) belong to its sheet: a write
			// there in a document no service worker controls has the sheet's
			// loads copied
			const parentRule = Reflect.getOwnPropertyDescriptor(
				styleProto,
				'parentRule',
			)!.get!;
			const parentSheet = Reflect.getOwnPropertyDescriptor(
				realm.CSSRule.prototype,
				'parentStyleSheet',
			)!.get!;
			const ruleWritten = (rule: unknown) => {
				try {
					const sheet = rule && Reflect.apply(parentSheet, rule, []);
					if (sheet) this.copyRules?.(sheet as CSSStyleSheet);
				} catch (error) {
					// not a rule
				}
			};
			const afterWrite = (declaration: unknown) => {
				const owner = owners.get(declaration as CSSStyleDeclaration);
				if (!owner) {
					if (!uncontrolled()) return;
					try {
						ruleWritten(Reflect.apply(parentRule, declaration, []));
					} catch (error) {
						// not a declaration block
					}
					return;
				}
				dropMarker(owner);
				copyInlineSoon(owner);
			};
			this.copyInline = (element) => copyInlineSoon(element);

			// One property's value. A URL named any way but a plain lower-case
			// url() token (a string of image-set() or src(), a url( spelled
			// with an escape, in upper case, or left unclosed) takes the
			// parser, which reads the value as a declaration's: the fast regex
			// below finds only a lower-case, closed url(, and the browser loads
			// the rest all the same (background-image:URL(...) and an unclosed
			// url( at the end of a value both fetch).
			const AS_DECLARATION = 'content:';
			const rewriteValue = (value: unknown) => {
				if (typeof value !== 'string') return value;
				if (/url\(|image-set|src\(|\\/i.test(value))
					try {
						const routed = modifyCSS(
							AS_DECLARATION + value,
							moduleClient.baseURL,
							'declarationList',
						);
						if (routed.startsWith(AS_DECLARATION))
							return routed.slice(AS_DECLARATION.length);
					} catch (error) {
						// not a value the parser takes: the url() tokens it has
					}
				// a url( in any case or spelled with an escape
				return /url\(|\\/i.test(value)
					? rewriteCSSValueURLs(value, moduleClient.baseURL)
					: value;
			};

			const cssTextSet = this.#nativeCssText.set!;
			const rewriteCssText = (value: unknown) => {
				try {
					return modifyCSS(
						String(value),
						moduleClient.baseURL,
						'declarationList',
					);
				} catch (error) {
					return value;
				}
			};

			// Chromium implements the named properties (style.backgroundImage = ...)
			// as per-instance named setters, so the only way to see those writes
			// is to hand the page a Proxy from the `style` getter.
			const declarationProxies = new LazyWeakMap<
				CSSStyleDeclaration,
				CSSStyleDeclaration
			>();
			// each page-facing declaration's own, which the prototype's methods
			// and setters are called with when the page calls them on the Proxy
			const declarationTargets = new LazyWeakMap<object, CSSStyleDeclaration>();
			// (a primitive is no key: WeakMap's get answers undefined)
			const real = (that: unknown) =>
				declarationTargets.get(that as object) || that;
			// a computed style's url() is absolute, natively: the real URL its
			// route stands for
			const computedDeclarations = new LazyWeakSet<CSSStyleDeclaration>();
			// a custom property's value is the page's tokens as written, computed
			// or not: its url() is neither resolved nor quoted
			const restore = (
				target: CSSStyleDeclaration,
				value: string,
				custom = false,
			) =>
				custom
					? restoreCSSValueURLs(value, undefined, true)
					: computedDeclarations.has(target)
						? restoreCSSValueURLs(value, (routed) =>
								computedURL(moduleClient, routed),
							)
						: restoreCSSValueURLs(value);

			const wrapDeclaration = (declaration: CSSStyleDeclaration) => {
				if (!declaration || typeof declaration !== 'object') return declaration;

				let proxy = declarationProxies.get(declaration);

				if (!proxy) {
					proxy = new Proxy(declaration, {
						// a method is the prototype's own, as natively: the
						// prototype's methods take the Proxy for its declaration
						// (`real`), and getPropertyValue reads back the page's URL
						// there like the named properties do here
						get: (target, key) => {
							const value = Reflect.get(target, key);
							return typeof value === 'string' && value.includes('url(')
								? restore(target, value)
								: value;
						},
						set: (target, key, value) => {
							if (key === 'cssText') {
								// past the prototype's setter, which routes the text too:
								// routed once
								Reflect.apply(cssTextSet, target, [rewriteCssText(value)]);
								afterWrite(target);
								return true;
							}
							if (typeof key === 'string') value = rewriteValue(value);
							const done = Reflect.set(target, key, value);
							afterWrite(target);
							return done;
						},
					});

					declarationProxies.set(declaration, proxy);
					declarationTargets.set(proxy, declaration);
				}

				return proxy;
			};
			this.wrapDeclaration = wrapDeclaration;
			// every element interface with an inline style of its own (a
			// MathML element's, too)
			const styleInterfaces = ELEMENT_STYLE_INTERFACES.flatMap((name) => {
				const ctor = (realm as unknown as Record<string, unknown>)[name];
				return typeof ctor === 'function' ? [ctor as typeof HTMLElement] : [];
			});

			for (const ctor of styleInterfaces) {
				const descriptor = Reflect.getOwnPropertyDescriptor(
					ctor.prototype,
					'style',
				);
				if (!descriptor?.get) continue;
				const get = descriptor.get;

				Reflect.defineProperty(ctor.prototype, 'style', {
					...descriptor,
					get: proxyModule.wrapFunction(get, (target, that, args) => {
						const declaration = Reflect.apply(target, that, args);
						if (declaration && typeof declaration === 'object')
							owners.set(declaration, that as Element);
						return wrapDeclaration(declaration);
					}),
					// `el.style = text` is a write of its cssText
					...(descriptor.set
						? {
								set: proxyModule.wrapFunction(
									descriptor.set,
									(target, that, args) => {
										const declaration = Reflect.apply(get, that, []);
										if (!declaration || typeof declaration !== 'object')
											return Reflect.apply(target, that, args);
										owners.set(declaration, that as Element);
										// the browser forwards the write to cssText's setter,
										// which routes it too: written past it, routed once
										Reflect.apply(cssTextSet, declaration, [
											rewriteCssText(args[0]),
										]);
										afterWrite(declaration);
									},
								),
							}
						: {}),
				});
			}

			// computed styles read back the page's URLs too
			realm.getComputedStyle = proxyModule.wrapFunction(
				realm.getComputedStyle,
				(target, that, args) => {
					const declaration = Reflect.apply(target, that, args);
					if (declaration && typeof declaration === 'object')
						computedDeclarations.add(declaration);
					return wrapDeclaration(declaration);
				},
			);

			// the Typed OM: values stringify with the page's URLs; what the page
			// parses or sets is routed
			const typed = realm as unknown as Record<string, any>;
			if (typeof typed.CSSStyleValue === 'function') {
				for (const name of ['parse', 'parseAll'])
					if (typeof typed.CSSStyleValue[name] === 'function')
						typed.CSSStyleValue[name] = proxyModule.wrapFunction(
							typed.CSSStyleValue[name],
							(target, that, args) => {
								if (args.length > 1) args[1] = rewriteValue(args[1]);
								return Reflect.apply(target, that, args);
							},
						);
				typed.CSSStyleValue.prototype.toString = proxyModule.wrapFunction(
					typed.CSSStyleValue.prototype.toString,
					(target, that, args) => {
						const value = Reflect.apply(target, that, args);
						return typeof value === 'string' && value.includes('url(')
							? restoreCSSValueURLs(value)
							: value;
					},
				);
			}
			// the element each page-facing attributeStyleMap belongs to: a write
			// there changes its inline style, whose loads are copied in a
			// document no worker controls (and released by a delete or clear)
			const mapOwners = new LazyWeakMap<object, Element>();
			for (const ctor of styleInterfaces) {
				const descriptor = Reflect.getOwnPropertyDescriptor(
					ctor.prototype,
					'attributeStyleMap',
				);
				if (!descriptor?.get) continue;
				Reflect.defineProperty(ctor.prototype, 'attributeStyleMap', {
					...descriptor,
					get: proxyModule.wrapFunction(
						descriptor.get,
						(target, that, args) => {
							const map = Reflect.apply(target, that, args);
							if (map && typeof map === 'object')
								mapOwners.set(map, that as Element);
							return map;
						},
					),
				});
			}
			// a style rule's styleMap: a write there changes the rule
			const mapRules = new LazyWeakMap<object, object>();
			{
				const descriptor = Reflect.getOwnPropertyDescriptor(
					realm.CSSStyleRule.prototype,
					'styleMap',
				);
				if (descriptor?.get)
					Reflect.defineProperty(realm.CSSStyleRule.prototype, 'styleMap', {
						...descriptor,
						get: proxyModule.wrapFunction(
							descriptor.get,
							(target, that, args) => {
								const map = Reflect.apply(target, that, args);
								if (map && typeof map === 'object') mapRules.set(map, that);
								return map;
							},
						),
					});
			}
			if (typeof typed.StylePropertyMap === 'function')
				for (const name of ['set', 'append', 'delete', 'clear'])
					if (typeof typed.StylePropertyMap.prototype[name] === 'function')
						typed.StylePropertyMap.prototype[name] = proxyModule.wrapFunction(
							typed.StylePropertyMap.prototype[name],
							(target, that, args) => {
								if (name === 'set' || name === 'append')
									for (let i = 1; i < args.length; i++)
										args[i] = rewriteValue(args[i]);
								const result = Reflect.apply(target, that, args);
								const owner = mapOwners.get(that);
								if (owner) {
									dropMarker(owner);
									copyInlineSoon(owner);
								} else if (uncontrolled()) ruleWritten(mapRules.get(that));
								return result;
							},
						);

			// the methods take the Proxy for its declaration (`real`): a write
			// routes, and a read of a page-facing declaration reads back the
			// page's URLs
			for (const name of [
				'setProperty',
				'removeProperty',
				'getPropertyValue',
				'getPropertyPriority',
				'item',
			] as const)
				styleProto[name] = proxyModule.wrapFunction(
					styleProto[name],
					(target, that, args) => {
						const declaration = real(that) as CSSStyleDeclaration;
						const write = name === 'setProperty' || name === 'removeProperty';
						if (name === 'setProperty' && args.length > 1)
							args[1] = rewriteValue(args[1]);
						const result = Reflect.apply(target, declaration, args);
						if (write) afterWrite(declaration);
						if (name === 'removeProperty') return restoreCSSValueURLs(result);
						return name === 'getPropertyValue' &&
							declaration !== that &&
							typeof result === 'string' &&
							result.includes('url(')
							? restore(declaration, result, String(args[0]).startsWith('--'))
							: result;
					},
				) as never;

			// newer Chromium moves the named properties (backgroundImage, ...)
			// onto CSSStyleProperties; wrap setters on both prototypes
			const protos = [
				styleProto,
				(
					realm as unknown as {
						CSSStyleProperties?: typeof CSSStyleDeclaration;
					}
				).CSSStyleProperties?.prototype,
			].filter((proto): proto is CSSStyleDeclaration => !!proto);

			for (const proto of protos)
				for (const name of Object.getOwnPropertyNames(proto)) {
					const descriptor = Reflect.getOwnPropertyDescriptor(proto, name)!;
					if (!descriptor.set || !descriptor.configurable) continue;

					const rewrite =
						name === 'cssText'
							? (value: unknown) => {
									try {
										return modifyCSS(
											String(value),
											moduleClient.baseURL,
											'declarationList',
										);
									} catch (error) {
										return value;
									}
								}
							: rewriteValue;

					Reflect.defineProperty(proto, name, {
						...descriptor,
						set: proxyModule.wrapFunction(
							descriptor.set,
							(target, that, args) => {
								const declaration = real(that);
								const result = Reflect.apply(target, declaration, [
									rewrite(args[0]),
								]);
								afterWrite(declaration);
								return result;
							},
						),
					});
				}
		}

		// A <style>'s sheet in a document no service worker controls, and a
		// sheet whose rules the page changed through the CSSOM there: their
		// loads are copied (../uncontrolledCopies.ts). The rules' own text and
		// methods the copies need are taken here, before the readback and
		// CSSOM modules (which apply later) wrap them.
		const ruleText = Reflect.getOwnPropertyDescriptor(
			realm.CSSRule.prototype,
			'cssText',
		)!.get!;
		const nativeRules = {
			sheet: {
				insert: realm.CSSStyleSheet.prototype.insertRule,
				delete: realm.CSSStyleSheet.prototype.deleteRule,
			},
			group: {
				insert: realm.CSSGroupingRule.prototype.insertRule,
				delete: realm.CSSGroupingRule.prototype.deleteRule,
			},
		};
		// a style rule's own declarations, not the page-facing view the
		// readback module (which applies later) hands out: the native
		// methods putCopies calls refuse that view
		const ruleStyle = Reflect.getOwnPropertyDescriptor(
			realm.CSSStyleRule.prototype,
			'style',
		)!.get!;
		const keyframeStyle = Reflect.getOwnPropertyDescriptor(
			realm.CSSKeyframeRule?.prototype ?? {},
			'style',
		)?.get;
		const ownerNode = Reflect.getOwnPropertyDescriptor(
			realm.StyleSheet.prototype,
			'ownerNode',
		)!.get!;
		// how the CSSOM pass of each <style> marks a rule it need not redo
		const sheetMarks = new WeakMap<StyleElement, (rule: CSSRule) => void>();
		this.copySheet = (style, mark) => {
			sheetMarks.set(style, mark);
			if (!uncontrolled()) return;
			try {
				copier().copySheet(style, mark);
			} catch (error) {
				// the part cannot be had: the sheet's loads stay routed
			}
		};
		this.copyRules = (sheet) => {
			if (!uncontrolled()) return;
			try {
				copier().copyRules(sheet);
			} catch (error) {
				// the part cannot be had: the sheet's loads stay routed
			}
		};

		// The elements the parser made from markup the page wrote into a
		// document no service worker controls: each load the rewrite left with
		// only its marker (see placeLoad) gets the page's value back and its
		// hooks run on the element itself, which makes its copy. Underneath the
		// hooks, so the page's observers see nothing. A classic script is not
		// one: it got its copy during the write, or (the transport in the
		// page) does not run. Under a document, an element or a shadow root: the
		// browser parses markup the inject rewrote into any of them
		// (setHTMLUnsafe, a shadow root's innerHTML)
		const LOADS = [
			...['src', 'href', 'xlink:href', 'srcset', 'poster', 'data'],
			'imagesrcset',
		];
		const marker = markerPrefix().replace(':', '\\:');
		const written = LOADS.map((name) => name.replace(':', '\\:'))
			.map(
				(name) =>
					`[${marker}${name}]:not([${name}]):not(script:not([type=module]))`,
			)
			.join(',');
		// a document a worker controls loads its elements itself, but for an
		// <object>'s data and an <embed>'s src: Chrome sends no such load
		// through a worker, so those are copies in every document (proxiedLoad)
		const OBJECT_LOADS: [string, string][] = [
			['object', 'data'],
			['embed', 'src'],
		];
		const writtenObjects = OBJECT_LOADS.map(
			([tag, name]) => `${tag}[${marker}${name}]:not([${name}])`,
		).join(',');
		moduleClient.writtenLoads = (root) => {
			const all = uncontrolled();
			let elements: Element[];
			try {
				elements = [
					...(Reflect.apply(
						nativeQuerySelectorAll[Reflect.apply(nativeNodeType, root, [])],
						root,
						[all ? written : writtenObjects],
					) as NodeListOf<Element>),
				];
			} catch (error) {
				return;
			}
			for (const element of elements)
				usePrototype(element, CustomElement.prototype, (element) => {
					const names = all
						? LOADS
						: OBJECT_LOADS.filter(([tag]) => tag === element.localName).map(
								([, name]) => name,
							);
					for (const name of names) {
						const page = element.getAttributeOG(name);
						if (page === null || element.hasAttribute(name)) continue;
						element.setAttribute(name, page);
						domHooksModule.updateAttributeHooks(element, name);
					}
				});
		};

		const validMethods = ['GET', 'POST'];

		this.formHook = (element) => {
			element.restoreAttributesOG('action');

			// this hook always sets a routed 'action', so on later runs (e.g. the
			// method changing) the attribute may hold our own value rather than
			// the page's; only record it as the original when it isn't ours
			const current = element.getAttribute('action');
			const routedPrefix = `${moduleClient.directory}html`;

			if (
				element.hasAttribute('action') &&
				current !== '' &&
				!current!.startsWith(routedPrefix)
			) {
				element.setAttributeOG('action', current!);
			}

			// a form without an action (or an empty one) submits to the document's
			// own address, which is already a route; the page reads it back
			// without an action, as it wrote it (a routed one would hand the page
			// the proxy's address, which it might route again)
			if (!element.hasAttributeOG('action')) return;
			// an action no base resolves submits nothing, natively: kept as
			// written (the page's own value)
			if (
				unresolvable(
					(element.getAttributeOG('action') ?? element.getAttribute('action'))!,
					this.client.baseHref,
				)
			) {
				element.setAttribute('action', element.getAttributeOG('action')!);
				return;
			}

			/**
			 * Absolute URL
			 */
			let action: string;
			try {
				action = moduleClient
					.encodingParse(
						(element.getAttributeOG('action') ??
							element.getAttribute('action'))!,
						moduleClient.baseHref,
					)
					.toString();
			} catch (error) {
				// no URL at all (`https://[`): the form keeps it as written and
				// its submission goes nowhere, as natively (the insertion pass
				// calls this outside the attribute hooks' own guard)
				return;
			}

			const methodIndex = validMethods.indexOf(
				element.getAttribute('method')?.toUpperCase() || '',
			);
			const method = validMethods[methodIndex === -1 ? 0 : methodIndex];

			switch (method) {
				case 'GET':
					element.setAttribute(
						'action',
						routeHTML(
							new StompURL(action, moduleClient.baseURL),
							moduleClient.baseURL,
							moduleClient.config,
							true,
							moduleClient.nestedRoute,
						),
					);
					break;
				case 'POST':
					element.setAttribute(
						'action',
						routeHTML(
							new StompURL(action, moduleClient.baseURL),
							moduleClient.baseURL,
							moduleClient.config,
							false,
							moduleClient.nestedRoute,
						),
					);

					break;
			}
		};

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
		const objectWindow = Reflect.getOwnPropertyDescriptor(
			realm.HTMLObjectElement.prototype,
			'contentWindow',
		)!.get!;
		const heldBlank = (moduleClient.heldBlank = (
			element,
			context = element instanceof realm.HTMLObjectElement
				? (Reflect.apply(objectWindow, element, []) as typeof globalThis | null)
				: null,
		) => {
			const state = loads.get(element);
			try {
				if (state && !state.url && context?.location.href === HELD)
					Reflect.apply(
						context.History.prototype.replaceState,
						context.history,
						[null, '', 'about:blank'],
					);
			} catch (error) {
				// another context already
			}
		});
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
		const toBase64 = realm.btoa.bind(realm);
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
		const connected = Reflect.getOwnPropertyDescriptor(
			realm.Node.prototype,
			'isConnected',
		)!.get!;
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
		domHooksModule.useAttributes(
			(element) => {
				// (a page's write; an insertion's pass writes none)
				if (!element.attributeTab.has('type')) return;
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
			},
			[
				['OBJECT', 'type'],
				['EMBED', 'type'],
				// (the property reflects the page's type: none for a held one)
				[
					realm.HTMLObjectElement,
					'type',
					(element) =>
						element.getAttributeOG('type') ??
						(isHiddenValue(element.getAttribute('type')) ? '' : false),
				],
			],
		);
		const proxiedLoad = (attribute: string) => (element: CustomElement) => {
			element.restoreAttributesOG(attribute);
			if (
				!element.hasAttribute(attribute) ||
				element.getAttribute(attribute) === ''
			)
				return;
			const written = element.getAttribute(attribute)!;
			element.setAttributeOG(attribute, written);
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
			const refused = moduleClient.loadRefusal(
				'object-src',
				resource.url,
				true,
			);
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
		// the property reads the page's URL from the original alone: the real
		// attribute is absent while the proxied copy loads, then a blob: URL
		const writtenURL = (attribute: string) => (element: CustomElement) => {
			const written = element.getAttributeOG(attribute);
			return written !== null && written !== ''
				? moduleClient
						.encodingParse(written, moduleClient.baseHref, element)
						.toString()
				: false;
		};
		domHooksModule.useAttributes(proxiedLoad('data'), [
			['OBJECT', 'data'],
			[realm.HTMLObjectElement, 'data', writtenURL('data')],
		]);
		domHooksModule.useAttributes(proxiedLoad('src'), [
			['EMBED', 'src'],
			[realm.HTMLEmbedElement, 'src', writtenURL('src')],
		]);

		// <a ping>, <area ping>: a list of URLs the browser posts to when the
		// link is followed. Each is routed, or the ping would reach the site
		// past the proxy (and name the proxy's URLs in Ping-From / Ping-To);
		// one that does not parse is dropped, as the browser drops it
		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('ping');
				if (
					element.hasAttribute('ping') &&
					element.getAttribute('ping')!.trim() !== ''
				) {
					const written = element.getAttribute('ping')!;
					element.setAttributeOG('ping', written);
					const routed: string[] = [];
					for (const token of written.split(/[\t\n\f\r ]+/)) {
						if (!token) continue;
						try {
							routed.push(routeXHR(pageURL(token)));
						} catch (error) {
							// not a URL
						}
					}
					element.setAttribute('ping', routed.join(' '));
				}
			},
			[
				['A', 'ping'],
				['AREA', 'ping'],
				[realm.HTMLAnchorElement, 'ping', ogOrFalse('ping')],
				[realm.HTMLAreaElement, 'ping', ogOrFalse('ping')],
			],
		);

		// <video poster>
		domHooksModule.useAttributes(routeAttribute('poster', routeBinary, true), [
			['VIDEO', 'poster'],
			[realm.HTMLVideoElement, 'poster', originalURL('poster')],
		]);

		// background on <body> and a table's parts: the legacy presentational
		// image, which Chrome still loads. body.background reflects the
		// attribute as the page wrote it (no URL resolution). One hook of
		// every element's attribute that routes it on those names (a hook per
		// name cost each frame about 1 KB)
		const routeBackground = routeAttribute('background', routeBinary, true);
		domHooksModule.useAttributes(
			(element) => {
				if (
					element.namespaceURI === HTML_NAMESPACE &&
					' body table thead tbody tfoot tr td th '.includes(
						` ${element.localName} `,
					)
				)
					routeBackground(element);
			},
			[
				['*', 'background'],
				[
					this.client.global.HTMLBodyElement,
					'background',
					ogOrFalse('background'),
				],
			],
		);

		// <button formaction>, <input formaction>: the form's method decides how
		// the query travels, as for <form action>
		domHooksModule.useAttributes(
			routeAttribute('formaction', (resource) =>
				routeHTML(
					resource,
					moduleClient.baseURL,
					moduleClient.config,
					true,
					moduleClient.nestedRoute,
				),
			),
			[
				['BUTTON', 'formaction'],
				['INPUT', 'formaction'],
				[realm.HTMLButtonElement, 'formAction', originalURL('formaction')],
				[realm.HTMLInputElement, 'formAction', originalURL('formaction')],
			],
		);

		// <link imagesrcset>: a preload's candidates, like <img srcset>
		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('imagesrcset');
				if (
					element.hasAttribute('imagesrcset') &&
					element.getAttribute('imagesrcset') !== ''
				) {
					element.setAttributeOG(
						'imagesrcset',
						element.getAttribute('imagesrcset')!,
					);
					element.setAttribute(
						'imagesrcset',
						stringifySrcset(
							parseSrcset(element.getAttribute('imagesrcset')!).map((src) => ({
								...src,
								url: routeBinary(pageURL(src.url)),
							})),
						),
					);
				}
			},
			[
				['LINK', 'imagesrcset'],
				[
					realm.HTMLLinkElement,
					'imageSrcset',
					(element) =>
						element.hasAttribute('imagesrcset') &&
						element.getAttribute('imagesrcset') !== '' &&
						(element.getAttributeOG('imagesrcset') ??
							element.getAttribute('imagesrcset'))!,
				],
			],
		);

		// a child frame's csp or credentialless attribute would put its
		// document outside what the service worker can serve or rewrite:
		// dropped, read back as written. Setting the property
		// (`iframe.credentialless = true`, `iframe.csp = policy`) drops it at
		// once too, so it is not dropped later on insertion, behind attributes
		// the page set after it, and the browser never asks the document for
		// the policy (the worker does: the frame's hints say it, and
		// DocumentClient.requiredCSP reads it); `csp` reads back as written
		const iframePrototype = realm.HTMLIFrameElement.prototype;
		for (const [attribute, property, getter] of [
			['csp', 'csp', (element) => element.getAttributeOG('csp') ?? ''],
			[
				'credentialless',
				'credentialless',
				(element) => element.hasAttributeOG('credentialless'),
			],
		] as [string, string, (element: CustomElement) => string | boolean][])
			domHooksModule.useAttributes(
				(element) => {
					element.restoreAttributesOG(attribute);
					if (element.hasAttribute(attribute)) {
						element.setAttributeOG(attribute, element.getAttribute(attribute)!);
						element.removeAttribute(attribute);
					}
				},
				[
					['IFRAME', attribute],
					...(Reflect.getOwnPropertyDescriptor(iframePrototype, property)?.set
						? [
								[realm.HTMLIFrameElement, property, getter] as [
									typeof HTMLIFrameElement,
									string,
									typeof getter,
								],
							]
						: []),
				],
			);

		// A child frame's sandbox: as the page wrote it, it would make the
		// document an opaque origin (without allow-same-origin), whose
		// navigations the service worker never sees, or keep the inject from
		// running (without allow-scripts). The page's value is kept in the
		// marker and read back as written; the real attribute is the page's
		// flags plus those two, without the top navigation flags (sandbox.ts),
		// so the browser itself keeps enforcing forms, popups, modals,
		// downloads, pointer lock, presentation and orientation lock, for the
		// frame's own frames and its popups too, from the next navigation on.
		// What it no longer enforces the frame's documents emulate from the
		// marker (DocumentClient.sandboxFlags). A frame whose sandbox takes away
		// scripts gets the script policy on the about:blank it shows now, before
		// the page can write into it. Setting the property
		// (`iframe.sandbox = x` writes through its token list, which no
		// attribute hook sees) applies at once too.
		const contentDocument = Reflect.getOwnPropertyDescriptor(
			iframePrototype,
			'contentDocument',
		)!.get!;
		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('sandbox');
				const lists = moduleClient.getModule(TokenListsModule);
				if (!element.hasAttribute('sandbox')) {
					lists?.sync(element, null);
					return;
				}
				const value = element.getAttribute('sandbox')!;
				lists?.sync(element, value);
				element.setAttributeOG('sandbox', value);
				element.setAttribute('sandbox', realSandbox(value));
				if (
					sandboxTokens(value).has('allow-scripts') &&
					moduleClient.allows('allow-scripts')
				)
					return;
				try {
					const child = Reflect.apply(
						contentDocument,
						element,
						[],
					) as Document | null;
					if (child && child.URL === 'about:blank') guardDocument(child);
				} catch (error) {
					// nothing shown yet
				}
			},
			[
				['IFRAME', 'sandbox'],
				...(Reflect.getOwnPropertyDescriptor(iframePrototype, 'sandbox')?.set
					? [
							[realm.HTMLIFrameElement, 'sandbox', nativeRead] as [
								typeof HTMLIFrameElement,
								string,
								typeof nativeRead,
							],
						]
					: []),
			],
		);

		domHooksModule.useAttributes(this.formHook, [
			['FORM', 'action'],
			['FORM', 'method'],
			[realm.HTMLFormElement, 'action', originalURL('action')],
			[realm.HTMLFormElement, 'method', nativeRead],
		]);

		// a base's href resolves against the document's URL, not against the
		// base URL (which client.baseURL follows once a base is in place, and
		// is the page's own base while loadHTML rewrites the markup)
		const documentURL = () => moduleClient.url;
		// the bases whose report-only refusal was reported (reportBase)
		const reported = new LazyWeakSet<Element>();
		// the refusal URL each base was given, for the page's href: a hook
		// that runs again (the base inserted) leaves it, as a write would be
		// another check of the base, and another violation
		const refusedBases = new LazyWeakMap<Element, [string, string, string]>();
		// where the page's code (or the markup) set or inserted a base the
		// browser may report as refused (../violations.ts noteBaseSite: the
		// browser's names the hook, the inject's nothing)
		const noteBase = (element: Element, url: string) => {
			try {
				deferred('noteBaseSite')(moduleClient, element, url);
			} catch (error) {
				// the part cannot be had: the violation names no place
			}
		};
		domHooksModule.useAttributes(
			(element) => {
				const refused = refusedBases.get(element);
				if (
					refused &&
					element.getAttribute('href') === refused[1] &&
					element.getAttributeOG('href') === refused[0]
				) {
					// (inserted: the browser judges it there)
					noteBase(element, refused[2]);
					return;
				}
				element.restoreAttributesOG('href');

				if (
					element.hasAttribute('href') &&
					element.getAttribute('href') !== ''
				) {
					const document = documentURL();
					element.setAttributeOG('href', element.getAttribute('href')!);
					const url = new URL(
						element.getAttribute('href')!,
						document.toString(),
					);
					// the page's base-uri (src/csp.ts): a base it refuses names a
					// refusal URL the browser's copy refuses, and the browser
					// refuses and reports it as natively (the document's URL stays
					// its base URL); a report-only one's refusal is reported
					const refusals = /^https?:$/.test(url.protocol)
						? moduleClient.pageRefusals('base-uri', url)
						: [];
					// a report-only refusal's report is a deferred part
					// (../rareAttributes.ts), made first: without it the base
					// applies to nothing (a refusal URL would be the browser's
					// base, where its copy of the policy only reports it)
					let reportBase: DeferredParts['reportBase'] | undefined;
					if (refusals.length)
						try {
							reportBase = deferred('reportBase');
						} catch (error) {
							element.removeAttribute('href');
							return;
						}
					if (
						/^https?:$/.test(url.protocol) &&
						moduleClient.baseRefused(url, element)
					) {
						const refusal = moduleClient.refusalURL(
							'https',
							url.href,
							url.href.replace(/#.*$/s, ''),
						);
						refusedBases.set(element, [
							element.getAttributeOG('href')!,
							refusal,
							url.href,
						]);
						noteBase(element, url.href);
						element.setAttribute('href', refusal);
						return;
					}
					if (refusals.length) noteBase(element, url.href);
					reportBase?.(moduleClient, element, url, reported);
					element.setAttribute(
						'href',
						routeHTML(
							new StompURL(url, document),
							document,
							moduleClient.config,
							false,
							moduleClient.nestedRoute,
						),
					);
				}
			},
			[
				['BASE', 'href'],
				[
					realm.HTMLBaseElement,
					'href',
					(element) =>
						element.hasAttribute('href') &&
						element.getAttribute('href') !== '' &&
						new URL(
							(element.getAttributeOG('href') ?? element.getAttribute('href'))!,
							documentURL().toString(),
						).toString(),
				],
			],
		);
	}
}
