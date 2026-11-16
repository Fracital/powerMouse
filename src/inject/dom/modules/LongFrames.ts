import { scopePrefix } from '../../modules/Unroute';
import type DocumentClient from '../Client';
import type EntryTimingModule from './EntryTiming';
import type { Admit } from './EntryTiming';
import { MARKER } from './MutationObserver';

/** what the page reads of one script of a long animation frame */
interface ScriptView {
	/** whether the page hears of the script at all */
	shown: boolean;
	/** the script that ran is not the page's to know (the proxy's own): no source */
	anonymous: boolean;
	sourceURL: string;
	invoker: string;
}

/** an invoker that names an element by its `src` attribute: `IMG[src="..."].onload` */
const BY_SOURCE = /^([^[\]]*\[src=")(.*)("\]\.[^[\]."]*)$/s;
// the browser's own, taken when the bundle runs
const nativeQuery =
	typeof Document === 'function'
		? Document.prototype.querySelectorAll
		: undefined;
const nativeGetAttribute =
	typeof Element === 'function' ? Element.prototype.getAttribute : undefined;

/**
 * A long animation frame names the scripts that ran in it, each with the
 * window it ran in: by the routed URL the browser loaded it from, and the
 * inject bundle's own for a callback the inject wraps. The page reads its
 * scripts' own URLs, and an element a handler is named by reads with the
 * `src` the page wrote. A script file of the proxy's own is not in the
 * list. A callback that started in the proxy's code and went on into the
 * page's (the reaction to a promise the inject made, as for fetch) stays,
 * without a source: the browser has only where it started.
 *
 * A frame also lists the scripts of other windows of its origin that ran
 * in it, each with that window (measured natively: a same-origin frame's
 * function run as its parent's callback is listed as a "descendant" with
 * the frame's window), and every proxied site is the proxy's one origin: a
 * script of a window that is not of the page's own origin, or not of its
 * page (the host's, another tab's), is left out, as the browser leaves
 * another origin's out.
 *
 * Not mapped: `sourceCharPosition` is the function's place in the script
 * as the rewriter printed it, as the columns of an error's stack are.
 *
 * Made when a document's first long animation frame reaches its page
 * (EntryTiming): the handler of every such entry from then on.
 */
export function longFrames(
	client: DocumentClient,
	timing: EntryTimingModule,
): Admit {
	const global = client.global as typeof globalThis & Record<string, any>;
	const PageArray = global.Array as ArrayConstructor;
	const freeze = global.Object.freeze as typeof Object.freeze;
	const views = new WeakMap<object, ScriptView>();
	const lists = new WeakMap<object, object[]>();
	const natives: Record<string, ((this: object) => any) | undefined> = {};
	const read = (script: object, name: string) =>
		Reflect.apply(natives[name]!, script, []);
	let scriptJSON: ((this: object) => unknown) | undefined;

	/** whether a script of `ran` (the window it ran in) is the page's to hear of */
	const ownWindow = (ran: unknown): boolean => {
		if (ran === null || ran === undefined || ran === client.global) return true;
		try {
			const other = (ran as Record<string, unknown>)[client.names.client] as
				DocumentClient | undefined;
			return (
				!!other &&
				other.proxiedTop === client.proxiedTop &&
				other.originKey !== null &&
				other.originKey === client.originKey
			);
		} catch (error) {
			return false;
		}
	};
	/** the page's URL of a script, or null for a file that is not a page's */
	const scriptURL = (url: string): string | null => {
		if (url === '') return '';
		const real = timing.pageURL(url) as string;
		if (real === '') return null;
		// a file of the proxy's origin outside its scope is the host's
		if (real === url) {
			const scope = scopePrefix(client);
			const origin = scope.slice(
				0,
				scope.indexOf('/', scope.indexOf('//') + 2),
			);
			if (url.startsWith(`${origin}/`)) return null;
		}
		return real;
	};
	/**
	 * The `src` attribute the page wrote where the browser has `routed`:
	 * the one of an element of the document that has it, else (an
	 * element that is not in the document) the page's URL in full
	 */
	const writtenSource = (routed: string): string => {
		try {
			for (const element of Reflect.apply(nativeQuery!, global.document, [
				'[src]',
			]) as Iterable<Element>)
				if (Reflect.apply(nativeGetAttribute!, element, ['src']) === routed) {
					const written = Reflect.apply(nativeGetAttribute!, element, [
						`${MARKER}src`,
					]) as string | null;
					if (written !== null) return written;
					break;
				}
		} catch (error) {
			// no document to look in
		}
		return timing.pageURL(routed) as string;
	};
	const view = (script: object): ScriptView => {
		let known = views.get(script);
		if (known) return known;
		known = { shown: true, anonymous: false, sourceURL: '', invoker: '' };
		try {
			const type = String(read(script, 'invokerType'));
			const file = type === 'classic-script' || type === 'module-script';
			const source = scriptURL(String(read(script, 'sourceURL')));
			const invoker = String(read(script, 'invoker'));
			known.shown =
				ownWindow(read(script, 'window')) && !(file && source === null);
			known.anonymous = source === null;
			known.sourceURL = source ?? '';
			if (file) known.invoker = scriptURL(invoker) ?? '';
			else {
				const element = BY_SOURCE.exec(invoker);
				known.invoker = element
					? `${element[1]}${writtenSource(element[2]!)}${element[3]}`
					: invoker;
			}
		} catch (error) {
			// not a script timing: the getters throw as natively
		}
		views.set(script, known);
		return known;
	};
	const installScript = (prototype: object) => {
		for (const name of ['invokerType', 'sourceURL', 'invoker', 'window'])
			natives[name] = Reflect.getOwnPropertyDescriptor(prototype, name)?.get;
		timing.hookGetter(prototype, 'sourceURL', (that, native) => {
			native();
			return view(that).sourceURL;
		});
		timing.hookGetter(prototype, 'invoker', (that, native) => {
			native();
			return view(that).invoker;
		});
		timing.hookGetter(prototype, 'sourceFunctionName', (that, native) => {
			const name = native();
			return view(that).anonymous ? '' : name;
		});
		timing.hookGetter(prototype, 'sourceCharPosition', (that, native) => {
			const position = native();
			return view(that).anonymous ? -1 : position;
		});
		scriptJSON = timing.hookJSON(prototype, (json, that) => {
			const shown = view(that);
			if ('sourceURL' in json) json.sourceURL = shown.sourceURL;
			if ('invoker' in json) json.invoker = shown.invoker;
			if (shown.anonymous) {
				if ('sourceFunctionName' in json) json.sourceFunctionName = '';
				if ('sourceCharPosition' in json) json.sourceCharPosition = -1;
			}
		});
	};
	let installed = false;
	/** the scripts of a frame the page sees: the browser's own list when all of it */
	const shownScripts = (frame: object, scripts: object[]): object[] => {
		const known = lists.get(frame);
		if (known) return known;
		let list = scripts;
		if (scripts.length) {
			if (!installed) {
				installed = true;
				installScript(Reflect.getPrototypeOf(scripts[0]!)!);
			}
			if (!scripts.every((script) => view(script).shown)) {
				list = new PageArray();
				for (const script of scripts)
					if (view(script).shown) list[list.length] = script;
				freeze(list);
			}
		}
		lists.set(frame, list);
		return list;
	};
	return timing.first((prototype) => {
		const nativeScripts = Reflect.getOwnPropertyDescriptor(
			prototype,
			'scripts',
		)?.get;
		if (!nativeScripts) return;
		timing.hookGetter(prototype, 'scripts', (that, native) =>
			shownScripts(that, native()),
		);
		timing.hookJSON(prototype, (json, that) => {
			if (!Array.isArray(json.scripts)) return;
			const shown = shownScripts(that, Reflect.apply(nativeScripts, that, []));
			const list = new PageArray();
			for (const script of shown)
				list[list.length] = scriptJSON
					? Reflect.apply(scriptJSON, script, [])
					: script;
			json.scripts = list;
		});
	});
}
