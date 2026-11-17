import ProxyModule from '../../modules/Proxy';
import type DocumentClient from '../Client';
import {
	nativeContentWindow,
	nativeEntryName,
	nativeFrameElement,
	nativeGetAttribute,
	nativeQuery,
} from '../longEntryNatives';
import type EntryTimingModule from './EntryTiming';
import type { Admit } from './EntryTiming';
import { MARKER } from './MutationObserver';

/** what a long task's culprit says of the frame it ran in */
const CONTAINER = [
	'containerType',
	'containerSrc',
	'containerId',
	'containerName',
];

/** what the page reads of one long task */
interface TaskView {
	/** whether the page hears of the task at all */
	shown: boolean;
	/** its name, where the browser's is not the page's view */
	name?: string;
	/** the culprit reads as a window of its own (no container) */
	window: boolean;
	/** the container the culprit is in, when it was found */
	container: Element | null;
}

/**
 * A long task names where it ran by the frames between it and the window
 * that hears of it. The browser answers for the proxy's frames: the host's
 * frame a proxied page is in is the "container" of the page's own tasks
 * (with the routed URL it loads), every proxied site is one origin (a task
 * of another site's frame is a "same-origin" one, natively a task of
 * another process nobody here hears of), and a container's `src` is the
 * route. The page reads what its own frame tree would say: a top page, and
 * a frame of another site than its parent, is a window of its own; a task
 * of a frame of another site, of the host, or of anything outside the page
 * is not reported; a frame of the page's site but another origin is a
 * cross-origin one, named without its container (measured natively, with
 * a.zone.localhost and b.zone.localhost); and a container's `src` is the
 * attribute the page wrote.
 *
 * An approximation: an ancestor's task does not say which ancestor ran
 * it, so a frame takes it for its parent's.
 *
 * Made when a document's first long task reaches its page (EntryTiming):
 * the handler of every such entry from then on.
 */
export function longTasks(
	client: DocumentClient,
	timing: EntryTimingModule,
): Admit {
	if (!nativeEntryName?.get) return () => true;
	const global = client.global as typeof globalThis & Record<string, any>;
	const PageArray = global.Array as ArrayConstructor;
	const proxyModule = client.getModule(ProxyModule)!;
	const views = new WeakMap<object, TaskView>();
	const culprits = new WeakMap<object, TaskView>();
	const natives: Record<string, ((this: object) => any) | undefined> = {};
	let nativeAttribution: ((this: object) => object[]) | undefined;
	let installed = false;
	let culpritJSON: ((this: object) => unknown) | undefined;

	const clientOf = (context: unknown): DocumentClient | undefined => {
		try {
			return (context as Record<string, unknown>)[client.names.client] as
				DocumentClient | undefined;
		} catch (error) {
			return undefined;
		}
	};
	const sameSite = (other: DocumentClient) =>
		other.siteKey !== null && other.siteKey === client.siteKey;
	const sameOrigin = (other: DocumentClient) =>
		other.originKey !== null && other.originKey === client.originKey;
	const attribute = (element: Element, name: string) =>
		Reflect.apply(nativeGetAttribute!, element, [name]) as string | null;
	/**
	 * The frame element the browser named as a culprit's container: the one
	 * the culprit's own document is in, in this document or in a frame's
	 * below it (every one is the proxy's origin to the browser)
	 */
	const containerOf = (culprit: object | undefined): Element | null => {
		if (!culprit || !nativeQuery || !nativeGetAttribute) return null;
		try {
			const read = (name: string) =>
				String(Reflect.apply(natives[name]!, culprit, []));
			if (read('containerType') === 'window') return null;
			const [src, id, name] = [
				read('containerSrc'),
				read('containerId'),
				read('containerName'),
			];
			let budget = 2000;
			const within = (document: Document): Element | null => {
				for (const element of Reflect.apply(nativeQuery!, document, [
					'iframe,frame,embed,object',
				]) as Iterable<Element>) {
					if (budget-- <= 0) return null;
					if (
						(attribute(element, 'src') ?? '') === src &&
						(attribute(element, 'id') ?? '') === id &&
						(attribute(element, 'name') ?? '') === name
					)
						return element;
					let inner: Document | null | undefined;
					try {
						inner = (
							Reflect.apply(nativeContentWindow!, element, []) as Window | null
						)?.document;
					} catch (error) {
						// not a frame, or not one to read
					}
					const found = inner ? within(inner) : null;
					if (found) return found;
				}
				return null;
			};
			return within(global.document);
		} catch (error) {
			// no document to look in
		}
		return null;
	};
	/** the `src` of a frame element as its page wrote it */
	const writtenSource = (element: Element): string =>
		attribute(element, `${MARKER}src`) ??
		(timing.pageURL(attribute(element, 'src') ?? '') as string);

	const view = (task: object): TaskView => {
		let known = views.get(task);
		if (known) return known;
		known = { shown: true, window: false, container: null };
		try {
			const name = String(Reflect.apply(nativeEntryName!.get!, task, []));
			const list = nativeAttribution
				? Reflect.apply(nativeAttribution, task, [])
				: [];
			const [culprit] = list;
			if (culprit && !installed) {
				installed = true;
				installCulprit(Reflect.getPrototypeOf(culprit)!);
			}
			const parent = client.nested ? clientOf(client.parent) : undefined;
			if (name === 'self') {
				// a page's own task: its container is the frame it is in,
				// which natively it has only in its parent's process
				known.window = !parent || !sameSite(parent);
				if (!known.window && nativeFrameElement)
					known.container = Reflect.apply(
						nativeFrameElement,
						global,
						[],
					) as Element | null;
			} else if (name.endsWith('-descendant')) {
				// (the container is the frame the culprit's own document is in)
				known.container = containerOf(culprit);
				const ran =
					known.container && nativeContentWindow
						? clientOf(Reflect.apply(nativeContentWindow, known.container, []))
						: undefined;
				if (ran && !sameSite(ran)) known.shown = false;
				else if (ran && !sameOrigin(ran)) {
					// another origin's frame is named without its container
					known.name = 'cross-origin-descendant';
					known.window = true;
				} else if (ran) known.name = 'same-origin-descendant';
			} else if (name.endsWith('-ancestor')) {
				if (!parent || !sameSite(parent)) known.shown = false;
				else
					known.name = sameOrigin(parent)
						? 'same-origin-ancestor'
						: 'cross-origin-ancestor';
			} else if (name === 'same-origin' || name === 'cross-origin-unreachable')
				// a window beside the page's own tree: the host's, another
				// tab's (a frame cannot tell its cousins from them)
				known.shown = !!parent;
			if (known.name === name) known.name = undefined;
		} catch (error) {
			// not a long task: the getters throw as natively
		}
		views.set(task, known);
		return known;
	};

	let renamed = false;
	/** entries read by the name their view has (hooked once one has another) */
	const rename = () => {
		if (renamed) return;
		renamed = true;
		const prototype = global.PerformanceEntry?.prototype as object | undefined;
		const descriptor =
			prototype && Reflect.getOwnPropertyDescriptor(prototype, 'name');
		if (!prototype || !descriptor?.get) return;
		Reflect.defineProperty(prototype, 'name', {
			...descriptor,
			get: proxyModule.wrapFunction(descriptor.get, (target, that, args) => {
				const name = Reflect.apply(target, that, args);
				return views.get(that)?.name ?? name;
			}),
		});
	};

	const installCulprit = (prototype: object) => {
		for (const name of CONTAINER)
			natives[name] = Reflect.getOwnPropertyDescriptor(prototype, name)?.get;
		const shown = (culprit: object, name: string, native: unknown) => {
			const task = culprits.get(culprit);
			if (!task) return native;
			if (task.window) return name === 'containerType' ? 'window' : '';
			if (name !== 'containerSrc') return native;
			return task.container
				? writtenSource(task.container)
				: timing.pageURL(native);
		};
		for (const name of CONTAINER)
			timing.hookGetter(prototype, name, (that, native) =>
				shown(that, name, native()),
			);
		culpritJSON = timing.hookJSON(prototype, (json, that) => {
			for (const name of CONTAINER)
				if (name in json) json[name] = shown(that, name, json[name]);
		});
	};
	/** the culprits of a task, each known by its task from here on */
	const tagged = (task: object, list: object[]): object[] => {
		const known = view(task);
		for (const culprit of list) culprits.set(culprit, known);
		return list;
	};
	return timing.first(
		(prototype) => {
			nativeAttribution = Reflect.getOwnPropertyDescriptor(
				prototype,
				'attribution',
			)?.get;
			if (!nativeAttribution) return;
			// (the culprits' getters first: a view reads them)
			timing.hookGetter(prototype, 'attribution', (that, native) =>
				tagged(that, native()),
			);
			timing.hookJSON(prototype, (json, that) => {
				const known = view(that);
				if (known.name !== undefined && 'name' in json) json.name = known.name;
				if (!Array.isArray(json.attribution)) return;
				const list = new PageArray();
				for (const culprit of tagged(
					that,
					Reflect.apply(nativeAttribution!, that, []),
				))
					list[list.length] = culpritJSON
						? Reflect.apply(culpritJSON, culprit, [])
						: culprit;
				json.attribution = list;
			});
		},
		(task) => {
			const known = view(task);
			if (known.name !== undefined) rename();
			return known.shown;
		},
	);
}
