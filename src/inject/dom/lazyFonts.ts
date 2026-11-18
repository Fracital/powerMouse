// A copied stylesheet's font faces, fetched as the text needs them: a
// deferred part of the document bundle (./deferredParts.ts), made at the
// first font face a document no service worker controls copies
// (./uncontrolledCopies.ts copiesOf).
//
// Natively Chrome fetches a face when text in its unicode-range is laid out
// in its family, weight and style, and never the rest: a Google Fonts sheet
// has a face for each subset and weight, and a page fetches one or two of
// them. Such a document's loads are copies the inject makes, and a copied
// sheet had every url() copied before the sheet was shown. So each face's
// source is a sentinel until the browser needs it: a font of one empty
// glyph that maps no character (so the text is drawn in the next family, as
// while a face loads), as a data: URL the browser loads without a request.
// When the browser loads one (the set's `loadingdone`, or a page's
// document.fonts.load()), the face's source is copied and its rule put back
// with the copy, and the browser loads that. Measured in Chrome 157: a face
// the text does not need stays `unloaded` and its sentinel is never read;
// one that is needed loads the sentinel at once, with no console message.
// A page that asks the set (load(), ready) is answered once the copies it
// started are in, as natively once the fetches are.
//
// This file's top level reads no global (it may be evaluated after page
// scripts ran).
import ProxyModule from '../modules/Proxy';
import { blobLoads } from './blobLoads';
import type DocumentClient from './Client';
import { nativeElement } from './modules/DOMHooks';

/** what the faces are read and put back with, taken before page scripts ran */
export interface LazyFontsTaken {
	/** a rule's own text */
	textOf: (rule: CSSRule) => string;
	/** the sheets' and grouping rules' own deleteRule and insertRule */
	rules: Record<'sheet' | 'group', { insert: Function; delete: Function }>;
	/** how the CSSOM pass of a <style> marks a rule it need not redo */
	marks: WeakMap<object, (rule: CSSRule) => void>;
}

/** one empty glyph, no character mapped (woff2, 188 bytes) */
const EMPTY_FONT =
	'd09GMgABAAAAAAC8AAoAAAAAAfgAAAB2AAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAALAoUMgE2AiQDBAsEAAQgBQYHIBthAfifBXZbWmcYes/SVo/G0fN4sHv7KwkKgjCywGMKxBJcc4jw1GsExNda9TUMG3CcQ6Qa0nIGgMAFlUb9XGzxEb69wcLgaYSn7YVlwTmcI0BgIQw2YIOmbgoI8Z3cm/GAv379EsYCIRBIAICEkBFYAADgagA=';
const SENTINEL = /data:font\/woff2;s=\d+;base64,[\w+/=]+/g;

/** a face's descriptors as the set's FontFace and the rule's declarations both serialise them */
const key = (values: string[]) =>
	values
		.map((value) => value.replace(/["']/g, '').replace(/\s+/g, ' ').trim())
		.join('|')
		.toLowerCase();

interface Pending {
	/** the route the sentinel stands for */
	routed: string;
	/** its copy, a blob: URL */
	copy: () => Promise<string>;
}

interface Face {
	rule: CSSFontFaceRule;
	/** the sheet or grouping rule it is in, and its sheet */
	container: CSSStyleSheet | CSSGroupingRule;
	sheet: CSSStyleSheet;
	key: string;
	family: string;
	/** the sentinels of its sources, in order */
	sentinels: string[];
}

/**
 * The maker of sentinels for `client`'s document: the URL that stands for
 * the font face source `routed` (the page's `page`) until the browser needs
 * it, then `copy` is made and put in its place.
 */
export function lazyFonts(client: DocumentClient, taken: LazyFontsTaken) {
	const realm = client.global;
	const { CSSFontFaceRule, CSSImportRule, CSSStyleSheet } = realm;
	/** a face's rule put back where it is with `text`, underneath the hooks */
	const replace = ({ rule, container, sheet }: Face, text: string) => {
		const methods =
			container instanceof CSSStyleSheet
				? taken.rules.sheet
				: taken.rules.group;
		const rules = container.cssRules;
		for (let i = 0; i < rules.length; i++)
			if (rules[i] === rule) {
				try {
					Reflect.apply(methods.delete, container, [i]);
					Reflect.apply(methods.insert, container, [text, i]);
					const style = client.styleElement(sheet.ownerNode);
					if (style) taken.marks.get(style)?.(rules[i]);
				} catch (error) {
					// a rule the browser will not take back: it keeps its sentinel
				}
				return;
			}
	};
	const wrap = client
		.getModule(ProxyModule)!
		.wrapFunction.bind(client.getModule(ProxyModule)!);
	const pending = new Map<string, Pending>();
	// the swap of each face's first sentinel while it is under way
	const swapping = new Map<string, Promise<void>>();
	let made = 0;

	/** every font face rule of the document, and those that hold sentinels */
	const faces = () => {
		const all: Face[] = [];
		const walk = (
			container: CSSStyleSheet | CSSGroupingRule,
			sheet: CSSStyleSheet,
		) => {
			const rules = container.cssRules;
			for (let i = 0; i < rules.length; i++) {
				const rule = rules[i];
				try {
					if (rule instanceof CSSFontFaceRule) {
						// the descriptors as the browser serialises the rule (the
						// readback modules wrap its declarations)
						const text = taken.textOf(rule);
						const read = (name: string, fallback: string) =>
							new RegExp(`[{;]\\s*${name}:\\s*([^;]*);`).exec(text)?.[1] ??
							fallback;
						const family = read('font-family', '');
						all.push({
							rule,
							container,
							sheet,
							family: key([family]),
							key: key([
								family,
								read('font-style', 'normal'),
								read('font-weight', 'normal'),
								read('font-stretch', 'normal'),
								read('unicode-range', 'U+0-10FFFF'),
							]),
							sentinels: (text.match(SENTINEL) ?? []).filter((url) =>
								pending.has(url),
							),
						});
					} else if (rule instanceof CSSImportRule) {
						if (rule.styleSheet) walk(rule.styleSheet, rule.styleSheet);
					} else if ('cssRules' in rule) walk(rule as CSSGroupingRule, sheet);
				} catch (error) {
					// a rule that cannot be read
				}
			}
		};
		const doc = realm.document;
		for (const sheets of [doc.styleSheets, doc.adoptedStyleSheets ?? []])
			for (let i = 0; i < sheets.length; i++)
				try {
					walk(sheets[i], sheets[i]);
				} catch (error) {
					// another origin's
				}
		return all;
	};

	/** a face's first source copied and its rule put back with the copy */
	const swap = (face: Face) => {
		const first = face.sentinels[0];
		let started = swapping.get(first);
		if (started) return started;
		const record = pending.get(first)!;
		started = record
			.copy()
			// a copy that failed: the route, which fails as it would have
			.catch(() => record.routed)
			.then((url) => {
				// the others are routes again: the browser tries them only when
				// the first fails
				let text = taken.textOf(face.rule);
				for (const sentinel of face.sentinels) {
					text = text
						.split(sentinel)
						.join(sentinel === first ? url : pending.get(sentinel)!.routed);
					pending.delete(sentinel);
				}
				replace(face, text);
			})
			.finally(() => swapping.delete(first));
		swapping.set(first, started);
		return started;
	};

	/** the swaps the browser's loads of `loaded` call for */
	const need = (loaded: FontFace[]): Promise<void>[] => {
		if (!pending.size || !loaded.length) return [];
		const all = faces();
		const started = new Set<Promise<void>>();
		for (const face of loaded) {
			const family = key([face.family]);
			const exact = key([
				face.family,
				face.style,
				face.weight,
				face.stretch,
				face.unicodeRange,
			]);
			// a face no rule's descriptors read as: every one of its family
			const known = all.some((rule) => rule.key === exact);
			for (const rule of all)
				if (
					rule.sentinels.length &&
					(known ? rule.key === exact : rule.family === family)
				)
					started.add(swap(rule));
		}
		return [...started];
	};

	const fonts = realm.document.fonts;
	const proto = realm.FontFaceSet.prototype;
	const forEach = proto.forEach;
	const loadedFaces = (set: FontFaceSet) => {
		const loaded: FontFace[] = [];
		Reflect.apply(forEach, set, [
			(face: FontFace) => face.status === 'loaded' && loaded.push(face),
		]);
		return loaded;
	};
	Reflect.apply(nativeElement.addEventListener, fonts, [
		'loadingdone',
		(event: FontFaceSetLoadEvent) => need([...event.fontfaces]),
	]);

	// the set answers once the copies its loads started are in
	const settled = async (set: FontFaceSet) => {
		for (;;) {
			const started = need(loadedFaces(set));
			for (const swap of swapping.values()) started.push(swap);
			if (!started.length) return;
			await Promise.allSettled(started);
		}
	};
	const load = Reflect.getOwnPropertyDescriptor(proto, 'load')!;
	Reflect.defineProperty(proto, 'load', {
		...load,
		value: wrap(load.value!, async (target, that, args) => {
			const loaded = await Reflect.apply(target, that, args);
			const started = need([...loaded]);
			if (!started.length) return loaded;
			await Promise.allSettled(started);
			return Reflect.apply(target, that, args);
		}),
	});
	const ready = Reflect.getOwnPropertyDescriptor(proto, 'ready')!;
	// one promise for each of the browser's
	const answers = new WeakMap<object, Promise<FontFaceSet>>();
	Reflect.defineProperty(proto, 'ready', {
		...ready,
		get: wrap(ready.get!, (target, that, args) => {
			const native = Reflect.apply(target, that, args) as Promise<FontFaceSet>;
			if (!pending.size && !swapping.size) return native;
			let answer = answers.get(native);
			if (!answer) {
				answer = native.then(async (set) => {
					await settled(set);
					return Reflect.apply(target, that, args) as Promise<FontFaceSet>;
				});
				answers.set(native, answer);
			}
			return answer;
		}),
	});

	return (routed: string, page: string, copy: () => Promise<string>) => {
		const url = `data:font/woff2;s=${++made};base64,${EMPTY_FONT}`;
		pending.set(url, { routed, copy });
		blobLoads.set(url, page);
		return url;
	};
}
