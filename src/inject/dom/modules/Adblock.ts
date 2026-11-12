import {
	compileFilter,
	type CompiledFilter,
	type Dom,
} from '../../../blocker/procedural';
import type { AdblockPage } from '../../../blocker/types';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient, { addDocumentOpenListener } from '../Client';

/**
 * The cosmetic side of the built-in blocker in a document (docs/adblock.md).
 * The service worker asks the engine what the lists say of the document's
 * URL and hands the answer over in the shell, before the page's markup:
 *
 * - the hide selectors become rules of a constructed stylesheet the
 *   document adopts. A content blocker's stylesheet is the user agent's and
 *   the page cannot read it; this one is an author's, so the page's
 *   `document.adoptedStyleSheets` is kept as a list of the page's own sheets
 *   (a view over the real list, which ends with the blocker's), and nothing
 *   is added to the DOM or to `document.styleSheets`;
 * - the generic rules for classes and ids are not all sent (the lists hold
 *   tens of thousands): the classes and ids the document really uses are
 *   collected from mutation records and asked of the worker in batches, and
 *   what it answers is added to the sheet;
 * - the procedural filters, which the crate only parses, run here
 *   (src/blocker/procedural.ts) after every batch of mutations;
 * - the scriptlets, already rewritten by the worker like any script of the
 *   page, run once the document is opened for the page's markup and before
 *   its first script, so what they wrap is the proxy's hooks and what they
 *   see is the page's own URLs.
 *
 * The mutation callback only queues the records' elements (weakly) and
 * arms a timer: typing in a page mutates on every key, and the work
 * (reading classes, asking the worker, running the procedural filters) is
 * done in slices off that path.
 *
 * All of it uses natives taken in `apply`, which runs before every other
 * module's (the module is added first) and takes nothing unless the blocker
 * is on: with it off a frame pays for none of this.
 */
export default class AdblockModule extends Module<DocumentClient> {
	#adopted = new WeakMap<object, Adopted>();
	apply() {
		if (!this.client.blocking) return;
		const global = this.client.global;
		if (typeof global.CSSStyleSheet !== 'function') return;
		let natives: Natives;
		try {
			natives = takeNatives(global);
		} catch (error) {
			return;
		}
		this.#hideSheet(natives);
		// the shell hands over what the lists say of this document
		this.client.adblock = (page) => {
			try {
				start(this.client, natives, page, this.#adopted);
			} catch (error) {
				console.warn('Stomp: the cosmetic rules could not be applied', error);
			}
		};
	}
	/** the page's `adoptedStyleSheets` is the list of its own sheets */
	#hideSheet(natives: Natives) {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const adopted = this.#adopted;
		const prototype = this.client.global.Document.prototype;
		Reflect.defineProperty(prototype, 'adoptedStyleSheets', {
			...natives.adopted,
			get: proxyModule.wrapFunction(
				natives.adopted.get!,
				(target, that, args) => {
					const state = adopted.get(that as object);
					return state ? state.view : Reflect.apply(target, that, args);
				},
			),
			set: proxyModule.wrapFunction(
				natives.adopted.set!,
				(target, that, args) => {
					const state = adopted.get(that as object);
					// the native setter converts and checks the page's value, and
					// throws what the page would have seen; the blocker's sheet
					// goes back on the end of whatever it took
					Reflect.apply(target, that, args);
					if (!state) return;
					const taken = Reflect.apply(
						natives.adopted.get!,
						that,
						[],
					) as ArrayLike<CSSStyleSheet>;
					state.own.length = 0;
					for (let i = 0; i < taken.length; i++)
						if (taken[i] !== state.sheet)
							state.own[state.own.length] = taken[i];
					state.commit(state.own);
				},
			),
		});
	}
}

/** a document's adopted sheets: the page's own, and the blocker's after them */
interface Adopted {
	sheet: CSSStyleSheet;
	/** the page's own sheets, an array of the page's realm */
	own: CSSStyleSheet[];
	/** what the page reads: `own` behind a proxy that keeps the real list in step */
	view: CSSStyleSheet[];
	/** the real list becomes `list` and the blocker's sheet; throws what the native setter throws */
	commit(list: ArrayLike<unknown>): void;
}

type Getter = () => unknown;

interface Natives {
	Function: FunctionConstructor;
	Array: ArrayConstructor;
	Sheet: typeof CSSStyleSheet;
	replaceSync: (text: string) => void;
	insertRule: (rule: string, index?: number) => number;
	rulesLength: (sheet: CSSStyleSheet) => number;
	adopted: PropertyDescriptor;
	documentQuery: Function;
	elementQuery: Function;
	closest: Function;
	getAttribute: Function;
	getAttributeNames: Function;
	removeAttribute: Function;
	setAttribute: Function;
	remove: Function;
	parentElement: Getter;
	textContent: Getter;
	nodeType: Getter;
	listLength: Getter;
	listItem: Function;
	getComputedStyle: Function;
	getPropertyValue: Function;
	setProperty: Function;
	styleOf: (element: Element) => CSSStyleDeclaration | null;
	evaluate: Function;
	snapshotLength: Getter;
	snapshotItem: Function;
	Observer: typeof MutationObserver;
	observe: Function;
	recordType: Getter;
	recordTarget: Getter;
	recordAdded: Getter;
	setTimeout: Function;
}

function takeNatives(global: typeof globalThis): Natives {
	const getter = (prototype: object, key: string): Getter =>
		Reflect.getOwnPropertyDescriptor(prototype, key)!.get! as Getter;
	const document = global.Document.prototype;
	const element = global.Element.prototype;
	const node = global.Node.prototype;
	const sheet = global.CSSStyleSheet.prototype;
	const declaration = global.CSSStyleDeclaration.prototype;
	const record = global.MutationRecord.prototype;
	const list = global.NodeList.prototype;
	const rules = getter(sheet, 'cssRules');
	const rulesLength = getter(global.CSSRuleList.prototype, 'length');
	// an element's inline style, by the interface that carries it
	const styles = [
		global.HTMLElement,
		global.SVGElement,
		(global as { MathMLElement?: typeof Element }).MathMLElement,
	]
		.map((constructor) =>
			constructor
				? Reflect.getOwnPropertyDescriptor(constructor.prototype, 'style')?.get
				: undefined,
		)
		.filter((get): get is () => CSSStyleDeclaration => !!get);
	return {
		Function: global.Function,
		Array: global.Array,
		Sheet: global.CSSStyleSheet,
		replaceSync: sheet.replaceSync,
		insertRule: sheet.insertRule,
		rulesLength: (target) =>
			Reflect.apply(
				rulesLength,
				Reflect.apply(rules, target, []),
				[],
			) as number,
		adopted: Reflect.getOwnPropertyDescriptor(document, 'adoptedStyleSheets')!,
		documentQuery: document.querySelectorAll,
		elementQuery: element.querySelectorAll,
		closest: element.closest,
		getAttribute: element.getAttribute,
		getAttributeNames: element.getAttributeNames,
		removeAttribute: element.removeAttribute,
		setAttribute: element.setAttribute,
		remove: element.remove,
		parentElement: getter(node, 'parentElement'),
		textContent: getter(node, 'textContent'),
		nodeType: getter(node, 'nodeType'),
		listLength: getter(list, 'length'),
		listItem: list.item,
		getComputedStyle: global.getComputedStyle,
		getPropertyValue: declaration.getPropertyValue,
		setProperty: declaration.setProperty,
		styleOf: (target) => {
			for (const get of styles)
				try {
					return Reflect.apply(get, target, []);
				} catch (error) {
					// not this interface's element
				}
			return null;
		},
		evaluate: document.evaluate,
		snapshotLength: getter(global.XPathResult.prototype, 'snapshotLength'),
		snapshotItem: global.XPathResult.prototype.snapshotItem,
		Observer: global.MutationObserver,
		observe: global.MutationObserver.prototype.observe,
		recordType: getter(record, 'type'),
		recordTarget: getter(record, 'target'),
		recordAdded: getter(record, 'addedNodes'),
		setTimeout: global.setTimeout,
	};
}

/** taken before the page runs */
const NativeWeakRef = WeakRef;
/** elements a slice of the queue reads before it yields */
const SLICE_ELEMENTS = 2000;
/** ms the first batch of mutations waits, and every later one */
const FIRST_BATCH_MS = 0;
const BATCH_MS = 60;
/** ms between two runs of the procedural filters */
const PROCEDURAL_MS = 250;
/** XPathResult.ORDERED_NODE_SNAPSHOT_TYPE */
const SNAPSHOT = 7;

function start(
	client: DocumentClient,
	natives: Natives,
	page: AdblockPage,
	adopted: WeakMap<object, Adopted>,
) {
	const global = client.global;
	const document = global.document;
	// a window another realm's bundle runs (an initial about:blank its
	// parent read, whose Window the frame's document keeps): a node this
	// bundle reads first, from a mutation record or a query, is wrapped in
	// the bundle's realm, once, and the page then gets it with that realm's
	// prototypes and natives (its <head> appended scripts unrewritten:
	// helper-seal). There the lists' selectors still hide what they name, and
	// the scriptlets run, but nothing reads the document's nodes: no generic
	// rules by class and id, no procedural filters
	const foreign = global !== globalThis;
	const elements = (found: unknown): Element[] => {
		const out: Element[] = [];
		const length = Reflect.apply(natives.listLength, found, []) as number;
		for (let i = 0; i < length; i++)
			out.push(Reflect.apply(natives.listItem, found, [i]) as Element);
		return out;
	};
	const attribute = (element: Element, name: string): string | null =>
		Reflect.apply(natives.getAttribute, element, [name]) as string | null;
	const declare = (element: Element, declarations: string) => {
		const style = natives.styleOf(element);
		if (!style) return;
		for (const part of declarations.split(';')) {
			const colon = part.indexOf(':');
			if (colon === -1) continue;
			const important = /!\s*important\s*$/i.test(part);
			Reflect.apply(natives.setProperty, style, [
				part.slice(0, colon).trim(),
				part
					.slice(colon + 1)
					.replace(/!\s*important\s*$/i, '')
					.trim(),
				important ? 'important' : '',
			]);
		}
	};
	const dom: Dom = {
		document,
		path: `${client.url.url.pathname}${client.url.url.search}`,
		queryAll: (root, selector) =>
			elements(
				Reflect.apply(
					root === document ? natives.documentQuery : natives.elementQuery,
					root,
					[selector],
				),
			),
		parent: (element) =>
			Reflect.apply(natives.parentElement, element, []) as Element | null,
		closest: (element, selector) =>
			Reflect.apply(natives.closest, element, [selector]) as Element | null,
		text: (element) =>
			(Reflect.apply(natives.textContent, element, []) as string | null) ?? '',
		attributes: (element) =>
			(Reflect.apply(natives.getAttributeNames, element, []) as string[]).map(
				(name) => [name, attribute(element, name) ?? ''],
			),
		computed: (element, pseudo, property) =>
			Reflect.apply(
				natives.getPropertyValue,
				Reflect.apply(natives.getComputedStyle, global, [element, pseudo]),
				[property],
			) as string,
		xpath: (expression, context) => {
			const result = Reflect.apply(natives.evaluate, document, [
				expression,
				context,
				null,
				SNAPSHOT,
				null,
			]);
			const out: Element[] = [];
			const length = Reflect.apply(
				natives.snapshotLength,
				result,
				[],
			) as number;
			for (let i = 0; i < length; i++) {
				const found = Reflect.apply(natives.snapshotItem, result, [i]) as Node;
				if (Reflect.apply(natives.nodeType, found, []) === 1)
					out.push(found as Element);
			}
			return out;
		},
		remove: (element) => Reflect.apply(natives.remove, element, []),
		removeAttribute: (element, name) =>
			Reflect.apply(natives.removeAttribute, element, [name]),
		removeClass: (element, name) => {
			const classes = attribute(element, 'class');
			if (classes === null) return;
			const kept = classes.split(/\s+/).filter((token) => token !== name);
			if (kept.length !== classes.split(/\s+/).length)
				Reflect.apply(natives.setAttribute, element, ['class', kept.join(' ')]);
		},
		style: declare,
	};

	// the sheet: the lists' selectors, one rule each (a selector this browser
	// does not take drops its own rule only), and the filters that are a
	// plain selector with a style
	const filters: CompiledFilter[] = [];
	const rules: string[] = [];
	for (const selector of page.hide)
		rules.push(`${selector}{display:none!important}`);
	for (const json of page.procedural) {
		const filter = compileFilter(json);
		if (!filter) continue;
		if (filter.css) rules.push(filter.css);
		else if (!foreign) filters.push(filter);
	}
	const sheet = new natives.Sheet();
	Reflect.apply(natives.replaceSync, sheet, [rules.join('\n')]);
	const addRule = (rule: string) => {
		try {
			Reflect.apply(natives.insertRule, sheet, [
				rule,
				natives.rulesLength(sheet),
			]);
		} catch (error) {
			// not a selector this browser takes
		}
	};

	// adopted after the page's own sheets, which the page keeps reading and
	// writing as the whole list (AdblockModule's accessor)
	const own = new natives.Array() as CSSStyleSheet[];
	const commit = (list: ArrayLike<unknown>) => {
		const next: unknown[] = [];
		for (let i = 0; i < list.length; i++) next.push(list[i]);
		next.push(sheet);
		Reflect.apply(natives.adopted.set!, document, [next]);
	};
	const changed = (
		target: CSSStyleSheet[],
		change: (copy: CSSStyleSheet[]) => boolean,
	): boolean => {
		const copy: CSSStyleSheet[] = [];
		copy.length = target.length;
		for (let i = 0; i < target.length; i++)
			if (i in target) copy[i] = target[i];
		if (!change(copy)) return false;
		commit(copy);
		return true;
	};
	const view = new Proxy(own, {
		// every write to the page's list goes to the real one first, which
		// refuses what the browser refuses (a sheet of another document, a
		// value that is no sheet) with the browser's own error
		defineProperty: (target, key, descriptor) =>
			changed(target, (copy) =>
				Reflect.defineProperty(copy, key, descriptor),
			) && Reflect.defineProperty(target, key, descriptor),
		deleteProperty: (target, key) =>
			changed(target, (copy) => Reflect.deleteProperty(copy, key)) &&
			Reflect.deleteProperty(target, key),
	});
	const state: Adopted = { sheet, own, view, commit };
	const adopt = () => {
		// what the document holds now (a page's document.open() keeps them)
		const held = Reflect.apply(
			natives.adopted.get!,
			document,
			[],
		) as ArrayLike<CSSStyleSheet>;
		own.length = 0;
		for (let i = 0; i < held.length; i++)
			if (held[i] !== sheet) own[own.length] = held[i];
		commit(own);
		adopted.set(document, state);
	};
	adopt();

	// the generic rules: the classes and ids the document uses, asked of
	// the worker once each
	const generic = !page.generichide && !foreign;
	const seen = new Set<string>();
	let classes: string[] = [];
	let ids: string[] = [];
	const note = (element: Element) => {
		const id = attribute(element, 'id');
		if (id && !seen.has(`#${id}`)) {
			seen.add(`#${id}`);
			ids.push(id);
		}
		const names = attribute(element, 'class');
		if (!names) return;
		for (const name of names.split(/\s+/))
			if (name && !seen.has(`.${name}`)) {
				seen.add(`.${name}`);
				classes.push(name);
			}
	};
	const origin = global.location.origin;
	const ask = () => {
		if (!classes.length && !ids.length) return;
		// about:srcdoc and blob: documents have no proxy-origin URL to ask
		if (!/^https?:$/.test(global.location.protocol)) return;
		const body = JSON.stringify({ classes, ids, exceptions: page.exceptions });
		classes = [];
		ids = [];
		fetch(`${origin}${client.directory}adblock`, { method: 'POST', body })
			.then((response) => response.json())
			.then((selectors: unknown) => {
				if (!Array.isArray(selectors)) return;
				for (const selector of selectors)
					if (typeof selector === 'string')
						addRule(`${selector}{display:none!important}`);
			})
			.catch(() => {});
	};

	// the procedural filters: every match is hidden (inline, the only way to
	// name one element) or given the filter's action, once
	const handled = new WeakSet<Element>();
	let proceduralAt = 0;
	let proceduralArmed = false;
	const procedural = () => {
		proceduralArmed = false;
		proceduralAt = Date.now();
		for (const filter of filters) {
			let matched: Element[];
			try {
				matched = filter.matches(dom);
			} catch (error) {
				continue;
			}
			for (const element of matched) {
				if (handled.has(element)) continue;
				handled.add(element);
				try {
					if (filter.hides) declare(element, 'display: none !important');
					else filter.act(element, dom);
				} catch (error) {
					// an element the page took away meanwhile
				}
			}
		}
	};
	const later = (callback: () => void, ms: number) =>
		Reflect.apply(natives.setTimeout, global, [
			client.ownCallback(callback),
			ms,
		]);
	const armProcedural = () => {
		if (!filters.length || proceduralArmed) return;
		proceduralArmed = true;
		later(procedural, Math.max(0, proceduralAt + PROCEDURAL_MS - Date.now()));
	};

	// the elements of the mutation records wait in a queue a timer reads in
	// slices, held weakly: a subtree the page writes and drops again (an
	// innerHTML it reads back, a list it rebuilds) is the page's to free
	// before the queue reaches it, and its classes are nobody's then. `deep`:
	// an added element, whose subtree is read too
	const queue: { element: WeakRef<Element>; deep: boolean }[] = [];
	let armed = false;
	let first = true;
	const drain = () => {
		armed = false;
		let budget = SLICE_ELEMENTS;
		while (queue.length && budget > 0) {
			const { element, deep } = queue.shift()!;
			const target = element.deref();
			if (!target) continue;
			note(target);
			budget--;
			if (!deep) continue;
			const inside = dom.queryAll(target, '[class],[id]');
			for (const element of inside) note(element);
			budget -= inside.length;
		}
		if (queue.length) arm();
		if (generic) ask();
		armProcedural();
	};
	const arm = () => {
		if (armed) return;
		armed = true;
		later(drain, first ? FIRST_BATCH_MS : BATCH_MS);
		first = false;
	};
	const observer = new natives.Observer((records) => {
		if (generic)
			for (const record of records) {
				if (Reflect.apply(natives.recordType, record, []) === 'attributes')
					queue.push({
						element: new NativeWeakRef(
							Reflect.apply(natives.recordTarget, record, []) as Element,
						),
						deep: false,
					});
				else
					for (const added of elements(
						Reflect.apply(natives.recordAdded, record, []),
					))
						if (Reflect.apply(natives.nodeType, added, []) === 1)
							queue.push({ element: new NativeWeakRef(added), deep: true });
			}
		arm();
	});
	const observe = () =>
		Reflect.apply(natives.observe, observer, [
			document,
			{
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['class', 'id'],
			},
		]);
	observe();

	// the scriptlets run in the document the page's markup is written to
	// (the open drops what a script registered on the window before it),
	// before the first script of the page; a document the page opens again
	// keeps its window, so they run once
	let ran = !page.script;
	addDocumentOpenListener(global, () => {
		try {
			adopt();
			observe();
		} catch (error) {
			// a document being torn down
		}
		if (ran) return;
		ran = true;
		try {
			Reflect.apply(
				client.compile([], page.script) ?? new natives.Function(page.script),
				global,
				[],
			);
		} catch (error) {
			// a scriptlet threw: the page runs without it, as natively
		}
	});
}
