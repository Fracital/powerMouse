// Chrome 157's markup insertion members, a deferred part of the document
// bundle (./deferredParts.ts), made at a page's first call of one of them
// (DOMHooks installs the wrappers, and takes what this needs before any page
// script ran): appendHTML(Unsafe), prependHTML(Unsafe), beforeHTML(Unsafe),
// afterHTML(Unsafe) and replaceWithHTML(Unsafe), on Element, ShadowRoot
// (append, prepend) and CharacterData (before, after, replaceWith). Their
// stream* forms are not hooked: DOMHooks takes them off the prototypes
// (MARKUP_INSERTION says why).
//
// What the browser measures, Chrome 157: markup is parsed in the receiver's
// context (a shadow root's host), or its parent's for before, after and
// replaceWith (a shadow root's host too; a fragment or the document as parent
// is a HierarchyRequestError, no parent at all a call that does nothing). The
// Unsafe forms take TrustedHTML (sinks `Element appendHTMLUnsafe`, `ShadowRoot
// appendHTMLUnsafe`, `Node afterHTMLUnsafe`), make declarative shadow roots
// and run the markup's scripts with runScripts (a declarative shadow root's
// too); the safe forms sanitize as setHTML does.
//
// So each is done as the inject's other markup sinks are. An Unsafe form's
// markup is rewritten (DOMHooks rewriteMarkup, its scripts too where they may
// run) and handed to the browser's member, as setHTMLUnsafe's is. A safe
// form, and markup that is text where it lands (a <style>'s, a <script>'s),
// is parsed by the browser in an inert copy of its context, and what that
// leaves goes in through the insertion hooks, as setHTML's does.
//
// Where the markup's scripts may run, what decides and rewrites what runs
// (the options read from the page's object, the options handed on, the
// parse the scripts are found in, finding them, reading their text, type
// and address, writing their rewrite, the markup handed on: settle) asks
// only natives taken before any page script ran and the language itself
// (indexes, `===`, string concatenation): a page that replaced Array,
// String, RegExp, Map or DOM methods by then decides none of it. This
// file's top level reads no global (it may be evaluated after page scripts
// ran).
import { trustedHTML } from '../trusted';
import type DocumentClient from './Client';
import cloneRawNode, {
	closeNoscripts,
	createHTMLElement,
	holderLike,
	inertDocumentOf,
	inertHTMLDocument,
	isHTMLTemplate,
	isScriptElement,
	parseHTMLFragmentIn,
	releaseMarkup,
} from './cloneNode';

type Kind = 'append' | 'prepend' | 'before' | 'after' | 'replaceWith';
type ScriptKind = 'classic' | 'module' | 'other';
type Fn = (...args: any[]) => any;

/**
 * Markup whose scripts may run (runScripts): whether it lands in a shadow
 * tree, and each script's rewrite with the page's text it was made from and
 * its kind, at the same place (what the page reads back, `record`)
 */
export interface ScriptNotes {
	shadow: boolean;
	written: string[];
	made: string[];
	kinds: ScriptKind[];
	/** a template's content had scripts (a declarative shadow root's) */
	deep: boolean;
	/** the options the browser is handed (parserOptions' record): settle may turn runScripts off */
	options: { runScripts: boolean };
}

/** what DOMHooks hands over, taken before any page script ran */
export interface MarkupContext {
	client: DocumentClient;
	/** the markup as the browser should parse it in `context` (DOMHooks rewriteMarkup) */
	rewrite: (
		markup: string,
		context: Element | null,
		scripts?: ScriptNotes,
	) => string;
	/** the wrapped natives, Element's, then ShadowRoot's, then CharacterData's */
	natives: Fn[];
	/** where each interface's natives end in `natives` */
	ends: number[];
	/** the page's append, prepend, before, after and replaceWith of Element, DocumentFragment and CharacterData, as the insertion hooks made them */
	inserts: Fn[];
	shadowHost: Fn | undefined;
	contentOf: Fn;
	importNode: Fn;
	/** the browser's own Node and Element members (DOMHooks' copies; imported, this file would make a cycle of DOMHooks' imports) */
	nativeNode: Node;
	nativeElement: Element;
}

const HTML = 'http://www.w3.org/1999/xhtml';
const XLINK = 'http://www.w3.org/1999/xlink';
// (DOMHooks insertionPrototypes, MARKUP_INSERTS)
const IFACES = ['Element', 'ShadowRoot', 'CharacterData'];
const INSERTS: Kind[] = ['append', 'prepend', 'before', 'after', 'replaceWith'];
// elements whose markup the parser takes as text (noscript: scripting is on
// in the page, not in the inert document the hooks parse in)
const TEXT_CONTEXTS = [
	'style',
	'script',
	'xmp',
	'iframe',
	'noembed',
	'noframes',
	'plaintext',
	'noscript',
];
// a classic script's types (the HTML standard's JavaScript MIME types)
const JS_TYPES = [
	'application/ecmascript',
	'application/javascript',
	'application/x-ecmascript',
	'application/x-javascript',
	'text/ecmascript',
	'text/javascript',
	'text/javascript1.0',
	'text/javascript1.1',
	'text/javascript1.2',
	'text/javascript1.3',
	'text/javascript1.4',
	'text/javascript1.5',
	'text/jscript',
	'text/livescript',
	'text/x-ecmascript',
	'text/x-javascript',
];
// a type with one of these in it is one the browser may do something with
// that is not a classic or module script's (an import map, speculation
// rules): no script of the kind runs from such markup
const SPECIAL_TYPES = [
	'javascript',
	'ecmascript',
	'jscript',
	'livescript',
	'module',
	'importmap',
	'speculationrules',
	'webbundle',
];
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const HEX = '0123456789abcdef';
const CONTROLS =
	'\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u0009\u000a\u000b\u000c\u000d\u000e\u000f' +
	'\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001f';

// String helpers of the language alone (an index, `===`, `+`): none asks a
// String.prototype method or a RegExp the page may have replaced
const lowerOf = (c: string): string => {
	for (let i = 0; i < 26; i++) if (UPPER[i] === c) return LOWER[i];
	return c;
};
const isSpace = (c: string) =>
	c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
/** ASCII lower case, ASCII whitespace off both ends */
const lowerTrim = (value: string): string => {
	let from = 0;
	let to = value.length;
	while (from < to && isSpace(value[from])) from++;
	while (to > from && isSpace(value[to - 1])) to--;
	let out = '';
	for (let i = from; i < to; i++) out += lowerOf(value[i]);
	return out;
};
/** `part` (lower case) at `at` in `value`, in any ASCII case */
const isAt = (value: string, at: number, part: string): boolean => {
	if (at + part.length > value.length) return false;
	for (let i = 0; i < part.length; i++)
		if (lowerOf(value[at + i]) !== part[i]) return false;
	return true;
};
/** `prefix` at the start of `value`, exactly */
const startsWith = (value: string, prefix: string): boolean => {
	if (prefix.length > value.length) return false;
	for (let i = 0; i < prefix.length; i++)
		if (value[i] !== prefix[i]) return false;
	return true;
};
const contains = (value: string, part: string): boolean => {
	for (let i = 0; i + part.length <= value.length; i++)
		if (isAt(value, i, part)) return true;
	return false;
};
const listed = (value: string, list: string[]): boolean => {
	for (let i = 0; i < list.length; i++) if (list[i] === value) return true;
	return false;
};
/** a string literal of `value`, as JSON.stringify writes one */
const quote = (value: string): string => {
	let out = '"';
	for (let i = 0; i < value.length; i++) {
		const c = value[i];
		if (c === '"') out += '\\"';
		else if (c === '\\') out += '\\\\';
		else if (c === ' ') out += '\\u2028';
		else if (c === ' ') out += '\\u2029';
		else if (c < ' ') {
			let code = 0;
			while (CONTROLS[code] !== c) code++;
			out += `\\u00${HEX[code >> 4]}${HEX[code & 15]}`;
		} else out += c;
	}
	return `${out}"`;
};
/**
 * An HTML script's text as it can go in markup and come out of the parser
 * the same: a `</script` in it would end it, and a `<script` after a `<!--`
 * would make its own end tag not end it (the markup after it its text). Both
 * written so a string, a regular expression, a template or a comment reads
 * the same: `<\/script`, `\x3Cscript`.
 */
const markupSafe = (text: string): string => {
	let out = '';
	let comment = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '<') {
			// (an index past the end would ask String.prototype)
			if (isAt(text, i + 1, '!--')) comment = true;
			else if (isAt(text, i + 1, '/script')) {
				out += '<\\/';
				i++;
				continue;
			} else if (comment && isAt(text, i + 1, 'script')) {
				out += '\\x3C';
				continue;
			}
		}
		out += c;
	}
	return out;
};
/** `value` put at the end of `list` as its own property (an index setter the page put on Array.prototype is not asked) */
const put = <T>(list: T[], value: T) => {
	Reflect.defineProperty(list, list.length, {
		value,
		writable: true,
		enumerable: true,
		configurable: true,
	});
};

export function markupMembers(shared: MarkupContext) {
	const { client, nativeNode, nativeElement } = shared;
	// (DOMHooks nativeGetter)
	const nativeAccessor = (prototype: object, key: string, set = false): Fn => {
		for (
			let object: object | null = prototype;
			object;
			object = Reflect.getPrototypeOf(object)
		) {
			const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
			const accessor = set ? descriptor?.set : descriptor?.get;
			if (accessor) return accessor;
		}
		throw new TypeError(`Stomp: no native accessor ${key}`);
	};
	const nodeTypeGet = nativeAccessor(nativeNode, 'nodeType');
	const parentGet = nativeAccessor(nativeNode, 'parentNode');
	const firstChildGet = nativeAccessor(nativeNode, 'firstChild');
	const nextGet = nativeAccessor(nativeNode, 'nextSibling');
	const namespaceGet = nativeAccessor(nativeElement, 'namespaceURI');
	const localNameGet = nativeAccessor(nativeElement, 'localName');
	const shadowRootGet = nativeAccessor(nativeElement, 'shadowRoot');
	const textGet = nativeAccessor(nativeNode, 'textContent');
	const ownerGet = nativeAccessor(nativeNode, 'ownerDocument');
	const innerGet = nativeAccessor(nativeElement, 'innerHTML');
	const innerSet = nativeAccessor(nativeElement, 'innerHTML', true);
	const textSet = nativeAccessor(nativeNode, 'textContent', true);
	const { appendChild } = nativeNode;
	const rootGet = nativeNode.getRootNode;
	const {
		attachShadow,
		getAttribute,
		getAttributeNS,
		hasAttribute,
		hasAttributeNS,
		removeAttribute,
		removeAttributeNS,
	} = nativeElement;
	const call = (fn: unknown, that: unknown, args: unknown[] = []): any =>
		Reflect.apply(fn as Fn, that, args);
	const typeOf = (node: unknown): number | null => {
		if (typeof node !== 'object' || node === null) return null;
		try {
			return call(nodeTypeGet, node);
		} catch (error) {
			return null;
		}
	};
	const parentOf = (node: Node): Node | null => call(parentGet, node);
	/** a node's children, by the native getters */
	const childrenOf = (node: Node): Node[] => {
		const children: Node[] = [];
		for (
			let child = call(firstChildGet, node);
			child;
			child = call(nextGet, child)
		)
			put(children, child);
		return children;
	};
	const hostOf = (node: unknown): Element | null => {
		try {
			return shared.shadowHost ? call(shared.shadowHost, node) : null;
		} catch (error) {
			return null;
		}
	};
	const document = () => client.global.document;
	const sweep = () => client.sweepFrames?.();
	// markup the inject rewrote that the browser's parser put in, in a
	// document no worker controls: the nodes the parser made get their
	// loads' copies now (DOMAttributes writtenLoads), a declarative shadow
	// root's too (by the browser's getter: a closed one is out of reach)
	const landedLoads = (root: Node, markup: string) => {
		client.writtenLoads?.(root);
		if (!/shadowrootmode/i.test(markup)) return;
		const queue = childrenOf(root);
		for (const node of queue) {
			if (typeOf(node) !== 1) continue;
			const shadow = call(shadowRootGet, node) as Node | null;
			if (shadow) {
				client.writtenLoads?.(shadow);
				for (const child of childrenOf(shadow)) put(queue, child);
			}
			for (const child of childrenOf(node)) put(queue, child);
		}
	};
	/** what the markup is where it lands: text (a <style>'s), markup the hooks put in (an SVG <style>'s or <script>'s), or markup for the browser's parser */
	const contextKind = (context: Element): 'text' | 'nodes' | null => {
		const name = call(localNameGet, context);
		if (call(namespaceGet, context) === HTML)
			return listed(name, TEXT_CONTEXTS) ? 'text' : null;
		return name === 'style' || name === 'script' ? 'nodes' : null;
	};
	/** `nodes` put in where `kind` puts them, through the page's hooked methods */
	// (Element's, DocumentFragment's, CharacterData's: 0, 5, 10 in inserts)
	const insertOf = (of: number, kind: Kind): Fn => {
		let at = 0;
		while (INSERTS[at] !== kind) at++;
		return shared.inserts[of + at];
	};
	const insert = (kind: Kind, that: Node, nodes: unknown[]) => {
		const type = typeOf(that);
		if (kind === 'append' || kind === 'prepend') {
			if (type === 1 && isHTMLTemplate(that))
				return call(insertOf(5, kind), call(shared.contentOf, that), nodes);
			return call(insertOf(type === 1 ? 0 : 5, kind), that, nodes);
		}
		return call(insertOf(type === 1 ? 0 : 10, kind), that, nodes);
	};
	/** a node of `iface` in the inert document with no parent: a native call on it converts the options and does nothing else */
	const detached = (iface: string, inert: Document): Node => {
		if (iface === 'CharacterData') return inert.createTextNode('');
		const div = inert.createElement('div');
		return iface === 'ShadowRoot'
			? call(attachShadow, div, [{ mode: 'open' }])
			: div;
	};
	/**
	 * The browser's member on an inert copy of `context` (a placeholder in
	 * it for before, after and replaceWith): the receiver the call is made
	 * on, the node its output lands in, and the placeholder
	 */
	const shellOf = (
		iface: string,
		kind: Kind,
		context: Element,
	): { receiver: Node; out: Node; placeholder: Node | null } => {
		const inert = inertDocumentOf(document());
		const shell = call(shared.importNode, inert, [context, false]) as Element;
		if (kind === 'append' || kind === 'prepend') {
			const receiver =
				iface === 'ShadowRoot'
					? (call(attachShadow, shell, [{ mode: 'open' }]) as Node)
					: shell;
			const out =
				iface !== 'ShadowRoot' && isHTMLTemplate(shell)
					? (call(shared.contentOf, shell) as Node)
					: receiver;
			return { receiver, out, placeholder: null };
		}
		const placeholder =
			iface === 'CharacterData'
				? inert.createTextNode('')
				: inert.createElement('span');
		call(appendChild, shell, [placeholder]);
		return { receiver: placeholder, out: shell, placeholder };
	};

	// The options an Unsafe member hands the browser, and whether the
	// markup's scripts may run: `runScripts: true` (Chrome 156) runs them as
	// the parser made them, so they are rewritten first, as a written page's
	// are (the rewrite restores the page's text as each runs). The page's
	// object is read once, as the browser reads it (runScripts, then
	// sanitizer; a getter or a Proxy's trap runs once each, a throwing one
	// throwing), into a record of no prototype that the browser is handed,
	// so what it reads is what was decided on. With a sanitizer the scripts
	// do not run: what it takes off the parsed markup (a type, a src, an
	// element round a script's text) can make a running script of one that
	// was none when it was rewritten, as Chrome 157 measures. A
	// TrustedHTMLParserOptions (Chrome 157) keeps its runScripts and
	// sanitizer to itself, so it is read as a dictionary too: none of its
	// markup's scripts runs, as before runScripts was honoured.
	const parserOptions = (
		options: unknown,
	): { options: unknown; scripts: boolean } => {
		if (
			options === null ||
			(typeof options !== 'object' && typeof options !== 'function')
		)
			return { options, scripts: false };
		const runScripts = !!Reflect.get(options, 'runScripts');
		const sanitizer = Reflect.get(options, 'sanitizer');
		const scripts = runScripts && sanitizer === undefined;
		const read = { __proto__: null, runScripts: scripts } as unknown as {
			runScripts: boolean;
			sanitizer?: unknown;
		};
		if (sanitizer !== undefined) read.sanitizer = sanitizer;
		return { options: read, scripts };
	};

	const textOf = (node: Node): string => call(textGet, node) ?? '';
	const setText = (node: Node, text: string) => call(textSet, node, [text]);
	/** notes for markup that lands under `node` with its scripts running, handed the browser with `options` (parserOptions' record) */
	const notes = (node: Node, options: unknown): ScriptNotes => {
		const root = call(rootGet, node);
		return {
			shadow: typeOf(root) === 11 && hostOf(root) !== null,
			written: [],
			made: [],
			kinds: [],
			deep: false,
			options: options as { runScripts: boolean },
		};
	};
	/**
	 * What a script element is, by its attributes as the browser reads them:
	 * a classic or a module script (rewritten), one of a kind that is not
	 * (an import map, speculation rules: emptied), or a data block, which
	 * nothing runs (left as it is)
	 */
	const scriptKindOf = (script: Element): ScriptKind | null => {
		let type = call(getAttribute, script, ['type']) as string | null;
		if (type === null) {
			const language = call(getAttribute, script, ['language']) as
				string | null;
			type = language ? `text/${language}` : '';
		}
		const kind = lowerTrim(type);
		if (kind === '' || listed(kind, JS_TYPES)) return 'classic';
		if (kind === 'module') return 'module';
		for (let i = 0; i < SPECIAL_TYPES.length; i++)
			if (contains(kind, SPECIAL_TYPES[i])) return 'other';
		return null;
	};
	/** a script that may not run: no address, no text */
	const neutralize = (script: Element) => {
		call(removeAttribute, script, ['src']);
		call(removeAttribute, script, ['href']);
		call(removeAttributeNS, script, [XLINK, 'href']);
		setText(script, '');
	};
	/**
	 * One script of markup whose scripts run, and whether it was changed:
	 * an external one keeps its address only if the hooks routed it (one
	 * the page's markup gave a data: or blob: address, or that the hooks did
	 * not reach, loads nothing); an inline one gets its rewrite, with the
	 * preamble that gives the running script the page's text back (none in
	 * a shadow tree, where document.currentScript is null), unless the
	 * page's script-src refuses it (no text, as natively it runs nothing).
	 * One whose text is a rewrite made here, of its kind, is left as it is.
	 */
	const settleScript = (
		script: Element,
		scripts: ScriptNotes,
		shadow: boolean,
	): boolean => {
		const kind = scriptKindOf(script);
		if (kind === null) return false;
		const html = call(namespaceGet, script) === HTML;
		const external =
			call(hasAttribute, script, [html ? 'src' : 'href']) ||
			(!html && call(hasAttributeNS, script, [XLINK, 'href']));
		if (kind === 'other') {
			if (!external && textOf(script) === '') return false;
			neutralize(script);
			return true;
		}
		if (external) {
			const prefix = `${client.originOf(client.global.location)}${client.directory}`;
			const addresses = html
				? [call(getAttribute, script, ['src'])]
				: [
						call(getAttribute, script, ['href']),
						call(getAttributeNS, script, [XLINK, 'href']),
					];
			for (let i = 0; i < addresses.length; i++) {
				const address = addresses[i] as string | null;
				if (address !== null && !startsWith(address, prefix)) {
					neutralize(script);
					return true;
				}
			}
			return false;
		}
		const source = textOf(script);
		if (source === '') return false;
		for (let i = 0; i < scripts.made.length; i++)
			if (scripts.made[i] === source && scripts.kinds[i] === kind) return false;
		if (client.refuseInlineScript(script, source, true)) {
			setText(script, '');
			return true;
		}
		client.giveCodeNonce(script, null, source, true);
		const rewritten = client.markupScript(
			source,
			kind === 'module',
			// (an SVG script is no document.currentScript either)
			kind === 'module' || shadow || !html
				? ''
				: `document.currentScript.textContent = ${quote(source)};`,
		);
		const text = html ? markupSafe(rewritten) : rewritten;
		setText(script, text);
		put(scripts.written, source);
		put(scripts.made, text);
		put(scripts.kinds, kind);
		return true;
	};
	/**
	 * Settle every script under `root` (settleScript), and say whether one
	 * was changed: every script element by the native getters, in the tree
	 * and in every template's content (a declarative shadow root's scripts
	 * run too, as Chrome 157 measures; in a shadow tree, with no preamble).
	 * A <noscript>'s markup is text in the page, where scripting is on: no
	 * script in it runs (closeNoscripts made sure it ends where it ends
	 * here). The page's text of each is noted for `record` (a script that
	 * has not run yet, one not connected, reads it back too).
	 */
	const settleTree = (
		root: Node,
		scripts: ScriptNotes,
		shadow: boolean,
	): boolean => {
		let changed = false;
		for (
			let node = call(firstChildGet, root);
			node;
			node = call(nextGet, node)
		) {
			if (typeOf(node) !== 1) continue;
			if (isScriptElement(node)) {
				if (settleScript(node, scripts, shadow)) changed = true;
				continue;
			}
			if (
				call(namespaceGet, node) === HTML &&
				call(localNameGet, node) === 'noscript'
			)
				continue;
			if (settleTree(node, scripts, shadow)) changed = true;
			if (isHTMLTemplate(node)) {
				const at = scripts.made.length;
				if (settleTree(call(shared.contentOf, node), scripts, true))
					changed = true;
				if (scripts.made.length !== at) scripts.deep = true;
			}
		}
		return changed;
	};
	/**
	 * An inert element to parse markup in as the browser parses it in
	 * `context` (none: a body): one like it (holderLike: its name, its
	 * namespace, an annotation-xml's encoding), in an inert document of its
	 * document's mode, in a <form> where it is in one
	 * (the parser's form element pointer, by which a <form> in the markup is
	 * parsed); and the node the markup lands in (a template's content)
	 */
	const holderFor = (
		context: Element | null,
	): { holder: Element; out: Node } | null => {
		const inert = inertHTMLDocument(
			context ? call(ownerGet, context) : document(),
		);
		if (!inert) return null;
		const holder = context
			? holderLike(inert, context)
			: createHTMLElement(inert, 'body');
		for (
			let node = context && parentOf(context);
			node && typeOf(node) === 1;
			node = parentOf(node)
		)
			if (
				call(localNameGet, node) === 'form' &&
				call(namespaceGet, node) === HTML
			) {
				call(appendChild, createHTMLElement(inert, 'form'), [holder]);
				break;
			}
		return {
			holder,
			out: isHTMLTemplate(holder) ? call(shared.contentOf, holder) : holder,
		};
	};
	/**
	 * `html` (DOMHooks rewriteMarkup's, for `context`) as it can be handed
	 * the browser to parse with runScripts: every script the browser's
	 * parser makes of it is one rewritten here. A tree the hooks made is not
	 * a tree the parser makes of its serialization (markup that parses into
	 * another shape the second time; a page whose replaced builtins the
	 * hooks asked on the way; a <noscript> that is markup here and text in
	 * the page), so the markup is parsed again by the browser's own parser,
	 * in an inert copy of the context, its scripts settled (settleTree) and
	 * its noscripts closed, and serialized again, until the parse makes
	 * every script one made here and serializes back to the same markup.
	 * Each round asks only the browser's own natives, taken before any page
	 * script ran (a page's code may run in the rewrite of a round's scripts,
	 * on that round's tree only: the next round is a parse of its own). If
	 * no round comes back to the same markup, runScripts is turned off and
	 * the scripts stay inert, as before runScripts was honoured.
	 */
	const settle = (
		html: string,
		context: Element | null,
		scripts: ScriptNotes,
	): string => {
		const made = holderFor(context);
		if (made) {
			let current = html;
			for (let round = 0; round < 4; round++) {
				call(innerSet, made.holder, [trustedHTML(current)]);
				let changed = closeNoscripts(made.out);
				if (settleTree(made.out, scripts, scripts.shadow)) changed = true;
				const next = call(innerGet, made.holder) as string;
				releaseMarkup(made.out);
				if (!changed && next === current) return current;
				current = next;
			}
		}
		scripts.options.runScripts = false;
		scripts.written = [];
		scripts.made = [];
		scripts.kinds = [];
		return html;
	};
	/** where `text` is among the rewrites made, or -1 */
	const madeAt = (scripts: ScriptNotes, text: string): number => {
		for (let i = 0; i < scripts.made.length; i++)
			if (scripts.made[i] === text) return i;
		return -1;
	};
	/**
	 * The page's text of each script the browser's parser made under `root`
	 * from rewritten markup (settle), for what the page reads back
	 * (Readback); in open shadow roots too
	 */
	const record = (root: Node, scripts: ScriptNotes) => {
		if (!scripts.made.length) return;
		for (
			let node = call(firstChildGet, root);
			node;
			node = call(nextGet, node)
		) {
			if (typeOf(node) !== 1) continue;
			if (isScriptElement(node)) {
				const text = textOf(node);
				const at = madeAt(scripts, text);
				if (at < 0) continue;
				const written = scripts.written[at];
				// (the parser's one text node holds the rewrite: it reads back as
				// the page's text)
				const pieces: [CharacterData, string][] = [];
				const children = childrenOf(node);
				for (let i = 0; i < children.length; i++)
					if (typeOf(children[i]) === 3)
						put(pieces, [
							children[i] as CharacterData,
							pieces.length ? '' : written,
						]);
				client.rewrittenScripts.set(node as HTMLScriptElement, text);
				client.scriptSource?.(node, written, text, pieces);
				continue;
			}
			record(node, scripts);
			if (scripts.deep) {
				const open = call(shadowRootGet, node);
				if (open) record(open, scripts);
			}
		}
	};

	/** a member: its markup at once */
	const insertMarkup = (
		iface: string,
		name: string,
		kind: Kind,
		unsafe: boolean,
		host: Element | null,
		target: Fn,
		that: Node,
		args: unknown[],
	): unknown => {
		let markup: string;
		if (unsafe) {
			// (the page's Trusted Types judge the markup first)
			const passed = client.trustedValue(
				args[0],
				'TrustedHTML',
				`${kind === 'append' || kind === 'prepend' ? iface : 'Node'} ${name}`,
				() => undefined,
			);
			if (passed === null) return;
			markup = passed;
		} else markup = String(args[0]);
		// the options as the browser is handed them (none where the page gave
		// none), and whether the scripts may run
		const given = args.length > 1;
		let options = args[1];
		let scripts: ScriptNotes | undefined;
		if (unsafe && given) {
			const parsed = parserOptions(options);
			options = parsed.options;
			if (parsed.scripts) scripts = notes(that, options);
		}
		const withMarkup = (first: unknown) => (given ? [first, options] : [first]);
		let context: Element | null;
		if (kind === 'append' || kind === 'prepend')
			context = host ?? (that as Element);
		else {
			const parent = parentOf(that);
			context =
				parent && (typeOf(parent) === 1 ? (parent as Element) : hostOf(parent));
			// no parent: nothing goes in; a fragment or the document: the
			// browser's error. Either as the browser answers it, for no markup
			if (!context) return call(target, that, withMarkup(''));
		}
		if (!unsafe) {
			// sanitized by the browser in an inert copy (its own errors: the
			// options, a sanitizer it refuses), and what it leaves put in
			// through the insertion hooks, which route it
			const { receiver, out, placeholder } = shellOf(iface, kind, context);
			call(target, receiver, args);
			const nodes: Node[] = [];
			const children = childrenOf(out);
			for (let i = 0; i < children.length; i++)
				if (children[i] !== placeholder) put(nodes, children[i]);
			if (nodes.length) insert(kind, that, nodes);
			sweep();
			return;
		}
		const where = contextKind(context);
		if (where) {
			// a <style>'s markup is its text, routed as it goes in, and a
			// <script>'s, rewritten as it goes in (a connected script that has
			// not run runs it); an SVG one's is markup the hooks put in. The
			// options are converted as the browser would, on a node of no parent
			call(
				target,
				detached(iface, inertDocumentOf(document())),
				withMarkup(''),
			);
			if (markup === '') return;
			insert(
				kind,
				that,
				where === 'text'
					? [markup]
					: [
							cloneRawNode(
								parseHTMLFragmentIn(markup, context, document()),
								document(),
							),
						],
			);
			sweep();
			return;
		}
		// (where it lands: the parent for before, after and replaceWith,
		// whose receiver may be gone after the call)
		const landing =
			kind === 'append' || kind === 'prepend' ? that : parentOf(that);
		const result = call(
			target,
			that,
			withMarkup(trustedHTML(shared.rewrite(markup, context, scripts))),
		);
		if (scripts && landing) record(landing, scripts);
		if (landing) landedLoads(landing, markup);
		sweep();
		return result;
	};

	const member = (target: Fn, that: Node, args: unknown[]): unknown => {
		const { natives, ends } = shared;
		let at = -1;
		for (let i = 0; i < natives.length; i++) if (natives[i] === target) at = i;
		if (at < 0) return call(target, that, args);
		// (a native's own name, which no page reaches)
		const name = target.name as string;
		const iface = IFACES[at < ends[0] ? 0 : at < ends[1] ? 1 : 2];
		let kind: Kind | null = null;
		let unsafe = false;
		for (let i = 0; i < INSERTS.length; i++)
			if (name === `${INSERTS[i]}HTML`) kind = INSERTS[i];
			else if (name === `${INSERTS[i]}HTMLUnsafe`) {
				kind = INSERTS[i];
				unsafe = true;
			}
		const type = typeOf(that);
		const host = iface === 'ShadowRoot' ? hostOf(that) : null;
		// a receiver of another interface, a missing or unconvertible markup:
		// the browser's own error, before anything is done
		if (
			kind === null ||
			!(iface === 'Element'
				? type === 1
				: iface === 'ShadowRoot'
					? host !== null
					: type === 3 || type === 4 || type === 7 || type === 8) ||
			!args.length ||
			typeof args[0] === 'symbol'
		)
			return call(target, that, args);
		return insertMarkup(iface, name, kind, unsafe, host, target, that, args);
	};
	return {
		member,
		parserOptions,
		notes,
		settle,
		record,
	};
}
