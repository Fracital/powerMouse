// The rare markup sinks DOMHooks hooks, a deferred part of the document
// bundle (./deferredParts.ts), made at a page's first call of one of them:
// execCommand's insertHTML, insertImage and createLink, Range's
// createContextualFragment, setHTMLUnsafe, setHTML, getHTML,
// XMLSerializer's serializeToString and the document.domain setter. DOMHooks
// installs the wrappers as the bundle loads, and takes what this needs before
// any page script ran (SinkContext); each wrapper makes the part before it
// calls anything of the browser's, so without it the call throws. A
// command execCommand runs as it is (another command, no value) does not
// need it. A separate group from ./markupMembers.ts: a page that sets markup
// with setHTMLUnsafe does not evaluate the insertion members. Its top level
// reads no global (constants and functions only).
import { routeHTML } from '../../rewriteHTML';
import StompURL from '../../StompURL';
import { usePrototype } from '../modules/Proxy';
import { unrouteCSS } from '../modules/Unroute';
import { withStack } from '../nativeErrors';
import { getPublicSuffix } from '../rewriter';
import { trustedHTML } from '../trusted';
import cloneRawNode, {
	inertDocumentOf,
	isHTMLTemplate,
	isScriptElement,
	releaseMarkup,
} from './cloneNode';
import type { DeferredParts } from './deferredParts';
import type { MarkupContext, ScriptNotes } from './markupMembers';
import type DOMHooksModule from './modules/DOMHooks';
import { CustomElement } from './modules/DOMHooks';
import { stylesheetPIs } from './stylesheetPIs';

type Fn = (...args: any[]) => any;

/** what DOMHooks hands over, taken before any page script ran */
export interface SinkContext {
	/** the module (its inertCopy, and its foldMarkup as the readback modules rewrapped it) */
	hooks: DOMHooksModule;
	/** what the markup insertion members are handed (the client, rewriteMarkup, the natives) */
	markup: MarkupContext;
	/** those members, made at the first need of them */
	members: () => ReturnType<DeferredParts['markupMembers']>;
	/** an HTML <style>'s markup set as its text, through the insertion hook */
	setStyleText: (style: Element, text: string) => void;
	/** Element's innerHTML setter, as DOMHooks hooked it */
	innerHTMLSet: Fn;
	/** Element's and DocumentFragment's replaceChildren, as the insertion hooks made them */
	replaceChildren: { element: Fn; fragment: Fn };
	/** Node's textContent, as the insertion hooks made it */
	textContent: PropertyDescriptor;
	elementSetHTML: Fn | undefined;
	elementGetHTML: Fn | undefined;
	/** the browser's document.domain getter */
	domainGet: Fn;
	/** Document's getSelection and querySelectorAll */
	getSelection: Fn;
	querySelectorAll: Fn;
	/** markers folded back into a copy (DOMHooks foldMarkers) */
	foldMarkers: (root: Node) => void;
	/** every element under `root` */
	querySelectorAllOf: (root: Node) => Element[];
	/** the module's document of no window for `node`'s kind of markup (inertCopy's) */
	inertDocumentFor: (node: Node) => Document;
}

/** getHTML's options, as the page gave them */
type ShadowOptions = {
	serializableShadowRoots?: boolean;
	shadowRoots?: ShadowRoot[];
};

const isIP = (host: string) =>
	host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host);

const escapeAttribute = (value: string) =>
	value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

export function markupSinks(context: SinkContext) {
	const { hooks, markup, members, setStyleText, foldMarkers } = context;
	const { client, nativeNode } = markup;
	const realm = client.global;
	const rewriteMarkup = markup.rewrite;
	const { inertCopy } = hooks;
	const { querySelectorAllOf } = context;
	// the element markup is parsed in for a setHTMLUnsafe: the element,
	// a shadow root's host (by the browser's own getters)
	const nodeTypeOf = Reflect.getOwnPropertyDescriptor(
		nativeNode,
		'nodeType',
	)!.get!;
	const markupContextOf = (that: unknown): Element | null => {
		try {
			if (Reflect.apply(nodeTypeOf, that, []) === 1) return that as Element;
			return markup.shadowHost
				? (Reflect.apply(markup.shadowHost, that, []) as Element)
				: null;
		} catch (error) {
			// not a node: the browser's error, after
			return null;
		}
	};
	const ownerDocumentOf = Reflect.getOwnPropertyDescriptor(
		nativeNode,
		'ownerDocument',
	)!.get!;
	// a host's shadow root by the browser's own getter: the copy's host is
	// read on the browser's Node prototype (usePrototype), which has none
	const shadowRootOf = Reflect.getOwnPropertyDescriptor(
		markup.nativeElement,
		'shadowRoot',
	)!.get!;
	// Markup the inject rewrote that the browser's parser put in, in a
	// document no worker controls: the rewrite left each load with only its
	// marker (the copy it started was the inert element's), so the nodes the
	// parser made get their copies now (DOMAttributes writtenLoads), a
	// declarative shadow root's too (each nested one by the browser's
	// getter: a closed one is out of reach)
	const landedLoads = (root: Node, markup: string) => {
		const roots = [root];
		for (const root of roots) {
			client.writtenLoads?.(root);
			if (/shadowrootmode/i.test(markup))
				for (const element of querySelectorAllOf(root)) {
					const shadow = Reflect.apply(shadowRootOf, element, []) as Node;
					if (shadow) roots.push(shadow);
				}
		}
	};
	// the element the selection starts in: the context the browser
	// parses inserted markup in
	const editingContext = (document: Document): Element | null => {
		try {
			const selection = Reflect.apply(
				context.getSelection,
				document,
				[],
			) as Selection | null;
			if (!selection || selection.rangeCount === 0) return null;
			const start = selection.getRangeAt(0).startContainer;
			return usePrototype(start, nativeNode, (node) =>
				node.nodeType === 1 ? (node as Element) : node.parentElement,
			);
		} catch (error) {
			return null;
		}
	};
	// getHTML: the browser's own serializer on a folded copy in the inert
	// document (see inertCopy), with a copy of each shadow root it could
	// serialize (open and serializable, or one the page lists) attached to
	// the copy of its host as the root is, its markers folded too; the
	// native call gets the page's options with the copies of the roots it
	// listed, so it decides what to include as it would on the page's own
	const copyWithShadows = <T extends Element | DocumentFragment>(
		node: T,
		options: ShadowOptions,
		// the copies of the roots the page listed, for the native call
		listed: ShadowRoot[],
		// every copy and shadow root made, to let go of after (releaseMarkup)
		made: Node[],
	): T =>
		usePrototype(node, nativeNode, (native) => {
			const copy = inertCopy(native) as T;
			made.push(copy);
			const originals: Node[] = [
				...(native.nodeType === 1 ? [native] : []),
				...querySelectorAllOf(native),
			];
			const copies: Node[] = [
				...(copy.nodeType === 1 ? [copy] : []),
				...querySelectorAllOf(copy),
			];
			originals.forEach((original, index) => {
				const host = original as Element;
				const root =
					(Reflect.apply(shadowRootOf, host, []) as ShadowRoot | null) ??
					options.shadowRoots?.find((root) => root.host === host) ??
					null;
				if (
					!root ||
					!(
						(options.serializableShadowRoots && root.serializable) ||
						options.shadowRoots?.includes(root)
					)
				)
					return;
				// the root as it is: the browser decides from these, as it would
				// from the page's own
				const shadow = (copies[index] as Element).attachShadow({
					mode: root.mode,
					serializable: root.serializable,
					clonable: root.clonable,
					delegatesFocus: root.delegatesFocus,
				});
				if (options.shadowRoots?.includes(root)) listed.push(shadow);
				made.push(shadow);
				for (const child of root.childNodes)
					shadow.append(
						child.nodeType === 1
							? copyWithShadows(child as Element, options, listed, made)
							: inertCopy(child),
					);
				foldMarkers(shadow);
			});
			foldMarkers(copy);
			return copy;
		});
	return {
		/** execCommand of insertHTML, insertImage or createLink (`command`, lowercased) with a value */
		execCommand(
			target: Fn,
			that: Document,
			args: unknown[],
			command: string,
		): unknown {
			let made: string | null = null;
			if (command === 'inserthtml') {
				// (the page's Trusted Types judge the markup first)
				const value = client.trustedValue(
					args[2],
					'TrustedHTML',
					'Document execCommand',
					() => Reflect.apply(target, that, args),
				);
				if (value === null) return false;
				args[2] = trustedHTML(rewriteMarkup(value, editingContext(that)));
				const result = Reflect.apply(target, that, args);
				landedLoads(that, '');
				client.sweepFrames?.();
				return result;
			}
			const value = String(args[2]);
			if (command === 'insertimage' && value !== '') {
				args[0] = 'insertHTML';
				args[2] = trustedHTML(
					rewriteMarkup(
						`<img src="${escapeAttribute(value)}">`,
						editingContext(that),
					),
				);
			} else if (command === 'createlink' && value !== '') {
				try {
					made = routeHTML(
						new StompURL(
							client.encodingParse(value, client.baseHref),
							client.baseURL,
						),
						client.baseURL,
						client.config,
						false,
						client.nestedRoute,
					);
					args[2] = made;
				} catch (error) {
					// no URL: the link is made of it as it is
				}
			} else return Reflect.apply(target, that, args);
			const result = Reflect.apply(target, that, args);
			if (command === 'insertimage') landedLoads(that, '');
			if (made !== null)
				for (const link of [
					...(Reflect.apply(context.querySelectorAll, that, [
						'a[href]',
					]) as NodeListOf<Element>),
				])
					// the ones the command made: the routed URL, and no record
					// of what the page wrote
					if (
						usePrototype(
							link,
							CustomElement.prototype,
							(element) =>
								element.getAttribute('href') === made &&
								!element.hasAttributeOG('href'),
						)
					)
						link.setAttribute('href', value);
			client.sweepFrames?.();
			return result;
		},
		/** Range.createContextualFragment */
		contextualFragment(target: Fn, that: Range, args: unknown[]): unknown {
			if (!args.length) return Reflect.apply(target, that, args);
			// (the page's Trusted Types judge the markup first)
			const markup = client.trustedValue(
				args[0],
				'TrustedHTML',
				'Range createContextualFragment',
				() => Reflect.apply(target, that, args),
			);
			if (markup === null) return;
			const start = that.startContainer;
			const owner = (
				start.nodeType === 9 ? start : start.ownerDocument
			) as Document;
			const inert = inertDocumentOf(owner);
			// the context element, as the spec picks it: the start node
			// if it is an element, else its parent element; none for a
			// document or fragment
			const element =
				start.nodeType === 1
					? (start as Element)
					: start.parentNode?.nodeType === 1
						? (start.parentNode as Element)
						: null;
			const holder = element
				? inert.createElementNS(element.namespaceURI, element.localName)
				: inert.createElement('body');
			const range = inert.createRange();
			range.selectNodeContents(holder);
			const parsed = Reflect.apply(target, range, [
				trustedHTML(markup),
			]) as DocumentFragment;
			const fragment = owner.createDocumentFragment();
			fragment.append(cloneRawNode([...parsed.childNodes], owner));
			// its scripts are the parser's, which run as they are
			client.parsedScripts(fragment);
			return fragment;
		},
		/** Element's and ShadowRoot's setHTMLUnsafe */
		setHTMLUnsafe(target: Fn, that: unknown, args: unknown[]): unknown {
			if (args.length) {
				// (the page's Trusted Types judge the markup first; what goes
				// on is the inject's, trusted)
				const markup = client.trustedValue(
					args[0],
					'TrustedHTML',
					`${(that as Node).nodeType === 1 ? 'Element' : 'ShadowRoot'} setHTMLUnsafe`,
					() => Reflect.apply(target, that, args),
				);
				if (markup === null) return;
				args[0] = trustedHTML(markup);
			}
			const kind = args.length ? client.styleKind(that) : null;
			if (kind === 'html')
				return setStyleText(that as Element, String(args[0]));
			// an SVG <style>'s markup is markup, its text routed as it
			// goes in, which the native call would not (no declarative
			// shadow root is made in a style)
			if (kind === 'svg')
				return Reflect.apply(context.innerHTMLSet, that, [args[0]]);
			// and a script's markup is its text, which a connected
			// script runs: rewritten as it goes in, by the same setter
			if (args.length && isScriptElement(that))
				return Reflect.apply(context.innerHTMLSet, that, [args[0]]);
			// (runScripts: the scripts are rewritten, ./markupMembers.ts
			// parserOptions; the context, by the browser's own getters)
			let scripts: ScriptNotes | undefined;
			if (args.length > 1) {
				const parsed = members().parserOptions(args[1]);
				args[1] = parsed.options;
				if (parsed.scripts)
					scripts = members().notes(that as Node, parsed.options);
			}
			const written = args.length ? String(args[0]) : '';
			if (args.length)
				args[0] = trustedHTML(
					rewriteMarkup(written, markupContextOf(that), scripts),
				);
			const result = Reflect.apply(target, that, args);
			if (scripts) members().record(that as Node, scripts);
			landedLoads(that as Node, written);
			client.sweepFrames?.();
			return result;
		},
		/** Element's and ShadowRoot's setHTML (`target` is the one it wraps) */
		setHTML(target: Fn, that: unknown, args: unknown[]): unknown {
			const ofShadow = target !== context.elementSetHTML;
			// the element whose context the markup is parsed in: a shadow
			// root's host, or the element itself
			let element: Element | null = null;
			try {
				if (ofShadow)
					element = Reflect.apply(markup.shadowHost!, that, []) as Element;
				else if (isScriptElement(that))
					// the browser leaves a script as it is
					element = null;
				else if ((that as Node).nodeType === 1) element = that as Element;
			} catch (error) {
				// no shadow root: the native call throws what the browser does
			}
			if (!element || !args.length) return Reflect.apply(target, that, args);
			// the copy is made in a document with no window, where nothing
			// loads: for an element of this realm's document one the insertion
			// hooks take as another's, so what the sanitizer leaves is routed
			// all through as it goes in (a declarative shadow root's, a
			// template's content: the page's own template document was taken
			// as seen and left them as written); for an element of another
			// realm (the creator's member on its frame's) the inert document
			// of the element's own, so the nodes are of the element's realm,
			// as natively
			const owner = Reflect.apply(ownerDocumentOf, element, []) as Document;
			const shell = Reflect.apply(
				markup.importNode,
				owner === realm.document
					? context.inertDocumentFor(element)
					: inertDocumentOf(owner),
				[element, false],
			) as Element;
			// (a sanitizer the browser refuses throws here, as natively)
			Reflect.apply(context.elementSetHTML!, shell, args);
			const kind = ofShadow ? null : client.styleKind(that);
			if (kind) {
				// a style's markup is its text, which is routed as it goes in
				const text = String(
					Reflect.apply(context.textContent.get!, shell, []) ?? '',
				);
				if (kind === 'html') setStyleText(that as Element, text);
				else Reflect.apply(context.textContent.set!, that, [text]);
				return;
			}
			// a template's markup is its content's
			const template = !ofShadow && isHTMLTemplate(that);
			const left = template
				? (Reflect.apply(markup.contentOf, shell, []) as DocumentFragment)
				: shell;
			Reflect.apply(
				ofShadow || template
					? context.replaceChildren.fragment
					: context.replaceChildren.element,
				template ? Reflect.apply(markup.contentOf, that, []) : that,
				[...left.childNodes],
			);
			// a frame the sanitizer was told to keep is injected as it connects
			client.sweepFrames?.();
		},
		/** Element's and ShadowRoot's getHTML */
		getHTML(target: Fn, that: unknown, args: unknown[]): unknown {
			// Element's on an element of any realm (a frame's, which the
			// creator's member serializes natively too), ShadowRoot's on a
			// shadow root; on anything else the browser's own error
			const ofShadow = target !== context.elementGetHTML;
			let kind: 'element' | 'shadow' | null = null;
			try {
				if (!ofShadow && Reflect.apply(nodeTypeOf, that, []) === 1)
					kind = 'element';
				else if (ofShadow && Reflect.apply(markup.shadowHost!, that, []))
					kind = 'shadow';
			} catch (error) {
				// not a node, or no shadow root
			}
			if (kind === null) return Reflect.apply(target, that, args);
			const options = (args[0] ?? {}) as ShadowOptions;
			// the page's options, with the copies of the roots it listed
			const listed: ShadowRoot[] = [];
			const call = () => [
				{
					serializableShadowRoots: !!options.serializableShadowRoots,
					shadowRoots: listed,
				},
			];
			// every copy made, the shadow roots' too, for releaseMarkup
			const made: Node[] = [];
			if (kind === 'element') {
				const copy = copyWithShadows(that as Element, options, listed, made);
				const html = Reflect.apply(target, copy, call()) as string;
				for (const node of made) releaseMarkup(node);
				return hooks.foldMarkup(html);
			}
			// a shadow root cannot be copied: its children are, under a
			// holder in the inert document, serialized as the root's
			const holder = inertCopy(realm.document.createElement('div'));
			for (const child of (that as ShadowRoot).childNodes)
				holder.append(
					child.nodeType === 1
						? copyWithShadows(child as Element, options, listed, made)
						: inertCopy(child),
				);
			foldMarkers(holder);
			const html = Reflect.apply(
				context.elementGetHTML!,
				holder,
				call(),
			) as string;
			releaseMarkup(holder);
			for (const node of made) releaseMarkup(node);
			return hooks.foldMarkup(html);
		},
		/** XMLSerializer's serializeToString: the same folded copy, serialised as XML */
		serializeToString(target: Fn, that: unknown, args: unknown[]): unknown {
			const node = args[0];
			if (!(node instanceof realm.Node))
				return Reflect.apply(target, that, args);
			const one = (node: Node) => {
				const clone = inertCopy(node);
				foldMarkers(clone);
				const xml = Reflect.apply(target, that, [clone]) as string;
				releaseMarkup(clone);
				return xml;
			};
			// a document cannot be copied: its children are, one by one,
			// which is how the serializer writes a document; its
			// xml-stylesheet PIs as the page wrote them
			const xml = unrouteCSS(
				client,
				node.nodeType === 9
					? Array.from(node.childNodes, one).join('')
					: one(node as Node),
			);
			return xml.includes('<?xml-stylesheet')
				? stylesheetPIs(client).fold(xml)
				: xml;
		},
		/** the document.domain setter (DOMHooks says what it does) */
		setDomain(that: Document, args: unknown[]): void {
			// (the getter refuses a receiver that is no document, as the
			// setter would)
			Reflect.apply(context.domainGet, that, []);
			const value = String(args[0]);
			// the effective domain: the host, or what an earlier write set
			const host = client.documentDomain ?? client.url.url.hostname;
			const refuse = (reason: string) =>
				withStack(
					new realm.DOMException(
						`Failed to set the 'domain' property on 'Document': ${reason}`,
						'SecurityError',
					),
				);
			// a sandboxed document never sets it, allow-same-origin or not
			if (client.sandboxFlags !== null)
				throw refuse('Assignment is forbidden for sandboxed iframes.');
			if (value === '') throw refuse("'' is an empty domain.");
			let parsed: string | null = null;
			try {
				parsed = new URL(`http://${value}/`).hostname;
			} catch (error) {
				// not a host
			}
			const shown = parsed ?? encodeURI(value);
			if (parsed !== host) {
				if (
					parsed === null ||
					isIP(host) ||
					isIP(parsed) ||
					!host.endsWith(`.${parsed}`)
				)
					throw refuse(`'${shown}' is not a suffix of '${host}'.`);
				// with the list's private section, as Chrome refuses it:
				// 'github.io' is a top-level domain to a page of its customer
				if (getPublicSuffix(parsed) === parsed)
					throw refuse(`'${shown}' is a top-level domain.`);
			}
			if (client.siteKeyed) client.setDocumentDomain(parsed!);
		},
	};
}
