// The site pool (Config.sites, src/controller/sitePool.ts) as a document's
// inject sees it: every window of another origin is another slot's, so
// another site's, which the browser restricts itself, except the hub's page
// (the host), which a proxied document never shows as a window of its world.
// A window of this origin may still be another site's (sites that share a
// slot): the membrane decides as it does without a pool. Read with the browser's own
// answers, taken when the bundle loads (the Framing module shows the page an
// empty ancestorOrigins and itself as its top).
import { SITE_FOCUS, type SitesConfig } from '../../config';
import type { HopPolicy, ScriptFacts } from '../../csp';
import { parseNestedMark } from '../../partition';
import { nestedMarkOf } from '../../rewriteHTML';
import { slotLibraryName, type SlotShare } from '../../slotShare';
import { BUILD } from '../../version';
import { catchRequiredArguments } from '../modules/Proxy';
import { OwnWeakMap } from '../ownCollections';
import type DocumentClient from './Client';
import { deferred } from './deferred';
import type ContextModule from './modules/Context';
import { invalidTargetOrigin, isWindow, standInKey } from './modules/Context';
import { markerPrefix } from './modules/MutationObserver';
import { Pool } from './pool';
import { pageSandbox, sandboxTokens } from './sandbox';

export const nativeParent = Reflect.getOwnPropertyDescriptor(
	globalThis,
	'parent',
)?.get;
export const nativeTopOf = Reflect.getOwnPropertyDescriptor(
	globalThis,
	'top',
)?.get;
export const nativeLength = Reflect.getOwnPropertyDescriptor(
	globalThis,
	'length',
)?.get;
export const nativeLocation = Reflect.getOwnPropertyDescriptor(
	globalThis,
	'location',
)?.get;
/**
 * a window's real origin (`self.origin`): its location's for a routed
 * document, its creator's for an about:blank or srcdoc one, "null" for a
 * sandboxed one
 */
export const nativeOrigin = Reflect.getOwnPropertyDescriptor(
	globalThis,
	'origin',
)?.get;
const nativeFocus = Reflect.getOwnPropertyDescriptor(globalThis, 'focus')
	?.value as (() => void) | undefined;
const nativeHasFocus = globalThis.Document?.prototype.hasFocus;

/**
 * Whether `window` (a window, or a stand-in of one) is one this realm may
 * not read: of another real origin (with the site pool, another slot's) or
 * a stand-in. Asked without an exception: the browser answers a window it
 * restricts with a null prototype (CrossOriginGetPrototypeOf), and a
 * window this realm reaches always has one (a window's prototype cannot be
 * changed). Every read the browser refuses throws a SecurityError, about
 * 3 us each, and a read of another slot's window that asked by throwing
 * cost about 20 us in all (frame-walk), where a native read costs 0.4.
 */
export const foreignWindow = (window: object): boolean =>
	Reflect.getPrototypeOf(window) === null;

/**
 * Whether the browser's main frame of `global`'s frame tree (the real top:
 * the hub's or the host's page) is of another origin than `origin`, false
 * for the main frame itself. Read off the top window's own origin, which
 * the browser refuses for a window of another origin (once per document:
 * the ancestors' list it would read instead is an object kept for the
 * window's life)
 */
export function mainFrameElsewhere(
	global: typeof globalThis,
	origin: string,
): boolean {
	let top: unknown;
	try {
		top = Reflect.apply(nativeTopOf!, global, []);
	} catch (error) {
		return false;
	}
	if (top === global || top === null || top === undefined) return false;
	try {
		return Reflect.apply(nativeOrigin!, top, []) !== origin;
	} catch (error) {
		return true;
	}
}

/** the site pool's helpers, once a document asked for them (siteWindows) */
let made: ReturnType<typeof makeSiteWindows> | undefined;

/**
 * The site pool's helpers, made the first time a document of a slot asks:
 * a frame without a pool (most), or one with its parent in reach, makes
 * none of them. Every function the bundle makes as it loads is a closure
 * each frame pays for (some 55 bytes, measure-frame-memory), these as well
 * as the rest.
 */
export const siteWindows = () => (made ??= makeSiteWindows());

function makeSiteWindows() {
	/** a window's parent as the browser has it (readable on a window of any origin) */
	const nativeParentOf = (window: unknown): unknown =>
		Reflect.apply(nativeParent!, window, []);

	/**
	 * The site pool: a top document of a slot (its parent is the hub's page)
	 * takes the focus its frame has in the hub, as it starts. The browser keeps
	 * a focused frame focused when its next document commits in another
	 * process, and sends that document the keys, but the new process does not
	 * hear of it, and the document reads `document.hasFocus()` false where a
	 * tab's page reads true. Its agent (same origin, same process, a frame of
	 * the hub's) holds the hub's frame that has focus (SiteHub #focused); the
	 * document asks the browser for focus only when that is its own frame, so
	 * it never takes it from the host's controls, and before any of the page's
	 * listeners exist, so the page sees no focus event natively absent.
	 */
	function keepTopFocus(global: typeof globalThis, hub: string) {
		try {
			const parent = Reflect.apply(nativeParent!, global, []) as Window &
				typeof globalThis;
			if (
				parent === global ||
				!isHub(global, parent, hub) ||
				Reflect.apply(nativeHasFocus!, global.document, [])
			)
				return;
			for (let i = 0; i < parent.length; i++) {
				let focused: unknown;
				try {
					// a window of another origin throws
					if (!Reflect.has(parent[i] as object, SITE_FOCUS)) continue;
					focused = Reflect.get(parent[i] as object, SITE_FOCUS);
				} catch (error) {
					continue;
				}
				if (focused === global) Reflect.apply(nativeFocus!, global, []);
				return;
			}
		} catch (error) {
			// a window that is going away
		}
	}

	/** the real origins of a window's ancestors (Location's members are its own, unforgeable) */
	const ancestorOriginsOf = (
		global: typeof globalThis,
	): DOMStringList | undefined =>
		(Reflect.apply(nativeLocation!, global, []) as Location).ancestorOrigins;

	/**
	 * The site pool (Config.sites): whether `context` is the hub's page, the
	 * real top of `global`'s frame tree when its last ancestor is of the hub's
	 * origin. Every other window of another origin is another site's, which the
	 * browser restricts itself.
	 */
	function isHub(global: typeof globalThis, context: unknown, hub: string) {
		try {
			if (context !== Reflect.apply(nativeTopOf!, global, [])) return false;
			const ancestors = ancestorOriginsOf(global);
			return !!ancestors?.length && ancestors[ancestors.length - 1] === hub;
		} catch (error) {
			return false;
		}
	}

	/** what siteTop answered for a window of this origin, and for which hub */
	const keptTops = new OwnWeakMap<
		typeof globalThis,
		{ hub: string; top: typeof globalThis }
	>();

	/**
	 * The site pool: the top of the proxied world, the window right below the
	 * hub's page (whatever origin it is now), or the real top of a tree the hub
	 * is not in (a popup). `global` may be a window of another origin (another
	 * slot's, read by the document `from`), whose ancestors are not `from`'s to
	 * read: its tree's top then, which is `from`'s own when the two windows are
	 * of one tree, else the window right below that tree's top.
	 */
	function siteTop(
		global: typeof globalThis,
		hub: string,
		from: typeof globalThis = global,
	): typeof globalThis {
		let ancestors: DOMStringList | undefined;
		// (a window of another origin refuses the read: asked first, since a
		// refusal costs an exception)
		let foreign = foreignWindow(global);
		// A window's answer is kept: it is a window of the frame's ancestors (or
		// its tree's top), and a frame keeps its place in the tree for as long as
		// it is in it (an ancestor that navigates or is taken out takes the frame
		// with it, and a window whose frame is gone has no parent). Every read of
		// `top` asks this, and the ancestors' origins are a new list each time
		const kept = foreign ? undefined : keptTops.get(global);
		if (kept?.hub === hub && Reflect.apply(nativeParent!, global, []) !== null)
			return kept.top;
		if (!foreign)
			try {
				ancestors = ancestorOriginsOf(global);
			} catch (error) {
				foreign = true;
			}
		if (foreign) {
			try {
				const top = Reflect.apply(nativeTopOf!, global, []);
				if (from !== global && top === Reflect.apply(nativeTopOf!, from, []))
					return siteTop(from, hub);
				// another tree, whose top may be a hub's page (never handed out):
				// the window right below it, as the top of a tree under a hub is
				let context: typeof globalThis = global;
				for (let depth = 0; depth < 64; depth++) {
					const parent = Reflect.apply(nativeParent!, context, []) as unknown;
					if (parent === context || parent === top) return context;
					context = parent as unknown as typeof globalThis;
				}
			} catch (error) {
				// a window that went away
			}
			return global;
		}
		try {
			const depth = ancestors?.length ?? 0;
			let context: typeof globalThis = global;
			if (!depth || ancestors![depth - 1] !== hub)
				context = Reflect.apply(
					nativeTopOf!,
					global,
					[],
				) as unknown as typeof globalThis;
			else
				for (let i = 0; i < depth - 1; i++)
					context = Reflect.apply(
						nativeParent!,
						context,
						[],
					) as unknown as typeof globalThis;
			if (
				typeof context === 'object' &&
				context !== null &&
				Reflect.apply(nativeParent!, global, []) !== null
			)
				keptTops.set(global, { hub, top: context });
			return context;
		} catch (error) {
			return global;
		}
	}

	/** how many windows a search for a slot's agent reads at most (slotAgentShare) */
	const AGENT_SEARCH = 64;

	/**
	 * The site pool: what the agent of `global`'s slot shares with the
	 * documents of its origin that have no proxied top in reach
	 * (src/controller/slotLibrary.ts), the value of `name` on the agent's
	 * window, or null. The agents are frames of the hub's page (or of its
	 * controller frame, below the real top), appended after the frames that
	 * show the sites: the frames of the real top are read from the last, then
	 * theirs. A window of another origin refuses the read, and the agent made
	 * the property for good before any document of its slot existed, so a
	 * document of the slot cannot have made it first. `client`: the property is
	 * one the agent changes (SITE_RUNS), read from the real top too (the hub's
	 * own, for a site shown without the pool) and from no window that holds a
	 * document's client under that name (a proxied page's, which may have made
	 * it).
	 */
	function slotAgentShare(
		global: typeof globalThis,
		name: string,
		client?: string,
	): unknown {
		try {
			const top = Reflect.apply(nativeTopOf!, global, []) as object;
			let level: object[] = [top];
			let read = 0;
			const held = (window: object) => {
				const value = Reflect.getOwnPropertyDescriptor(window, name);
				return value &&
					'value' in value &&
					(client
						? !Reflect.getOwnPropertyDescriptor(window, client)
						: !value.configurable && !value.writable)
					? value
					: undefined;
			};
			if (client && top !== global)
				try {
					const value = held(top);
					if (value) return value.value;
				} catch (error) {
					// another origin's
				}
			for (let depth = 0; depth < 2 && read < AGENT_SEARCH; depth++) {
				const below: object[] = [];
				for (const parent of level) {
					const count = Number(Reflect.apply(nativeLength!, parent, [])) || 0;
					for (let i = count - 1; i >= 0 && read < AGENT_SEARCH; i--) {
						read++;
						const child = Reflect.get(parent, i) as object | undefined;
						if (!child || child === global) continue;
						let value: PropertyDescriptor | undefined;
						try {
							value = held(child);
						} catch (error) {
							// another origin's: the hub's controller frame, another slot's
							below.push(child);
							continue;
						}
						if (value) return value.value;
					}
				}
				level = below;
			}
		} catch (error) {
			// a window that went away
		}
		return null;
	}

	/**
	 * What the agent of `client`'s slot shares with it, for a frame of
	 * another slot than its page's (slotMark), which has no proxied top in
	 * reach: the light library in a realm no page code runs in, which the
	 * agent made before any document of its slot existed, and the file's
	 * statements. Null for every other document, and for an agent of
	 * another build. Looked up once
	 */
	function slotShared(client: DocumentClient): SlotShare | null {
		// (apart: a document compiles what it runs, and most run without a pool)
		if (client.slotMark === null) return null;
		const pool = client.pool;
		if (pool[Pool.SlotShared] !== undefined) return pool[Pool.SlotShared];
		pool[Pool.SlotShared] = null;
		if (client.sandboxedOpaque) return null;
		try {
			const share = slotAgentShare(
				client.global,
				slotLibraryName(client.names.client),
			) as SlotShare | null;
			if (
				typeof share === 'object' &&
				share !== null &&
				share.build === BUILD &&
				typeof share.rewriter === 'object' &&
				share.rewriter !== null &&
				share.rewriter.build === BUILD
			)
				pool[Pool.SlotShared] = share;
		} catch (error) {
			// an agent of another kind
		}
		return pool[Pool.SlotShared];
	}

	/** DocumentClient.slotMark, read once per document */
	function slotMarkOf(
		client: DocumentClient,
		sites: SitesConfig,
	): ReturnType<typeof parseNestedMark> {
		const global = client.global;
		const document = global.document;
		const pool = client.pool;
		if (pool[Pool.MarkDocument] === document) return pool[Pool.Mark];
		let mark: ReturnType<typeof parseNestedMark> = null;
		try {
			const parent = client.parent;
			let reached = true;
			try {
				void (client.names.client in parent);
			} catch (error) {
				reached = false;
			}
			// (a parent in reach first: most frames have one)
			if (!reached && !isHub(global, parent, sites.hub)) {
				const here = Reflect.apply(nativeLocation!, global, []) as Location;
				// (a called document's location is its call page's: its route
				// is the one the call named, which its parent marked)
				const routed = client.called?.session.routed;
				const text = nestedMarkOf(
					routed ? new URL(routed, here.href).pathname : here.pathname,
					client.directory,
					client.codec,
				);
				mark = text === null ? null : parseNestedMark(text);
			}
		} catch (error) {
			// a window that is going away
		}
		pool[Pool.MarkDocument] = document;
		pool[Pool.Mark] = mark;
		return mark;
	}

	/**
	 * The origins of `client`'s ancestors past `last`, the outermost
	 * document above it in reach, whose parent is of another slot: the top
	 * its route names (slotMark), when the top is the one ancestor left (the
	 * browser's own list counts them, the hub's page last). With more, which
	 * ones are not known here, and none is named.
	 */
	function ancestorsPast(
		client: DocumentClient,
		sites: SitesConfig,
		last: DocumentClient,
		known: number,
	): string[] {
		const top = last.slotMark?.top;
		if (!top) return [];
		let count: number;
		try {
			const list = ancestorOriginsOf(client.global)!;
			count = list.length;
			if (count && list[count - 1] === sites.hub) count--;
		} catch (error) {
			return [];
		}
		return count - known === 1 ? [top] : [];
	}

	/**
	 * How the browser navigated to the document
	 * (navigation.activation.navigationType), with the getters as they were
	 * before any page code ran
	 */
	function activationType(global: typeof globalThis): (() => string) | null {
		try {
			const navigation = (global as { navigation?: object }).navigation;
			const activationProto = (
				global as unknown as { NavigationActivation?: { prototype: object } }
			).NavigationActivation?.prototype;
			if (!navigation || !activationProto) return null;
			const activation = Reflect.getOwnPropertyDescriptor(
				Reflect.getPrototypeOf(navigation)!,
				'activation',
			)?.get;
			const type = Reflect.getOwnPropertyDescriptor(
				activationProto,
				'navigationType',
			)?.get;
			if (!activation || !type) return null;
			return () => {
				try {
					const current = Reflect.apply(activation, navigation, []);
					return current ? String(Reflect.apply(type, current, [])) : '';
				} catch (error) {
					return '';
				}
			};
		} catch (error) {
			return null;
		}
	}

	/**
	 * The document's entry of the session history as the browser has it, read
	 * with the Navigation API's getters as they were before any page code ran:
	 * under a site pool, the agent of the page's slot steps a frame in the page
	 * by it when the frame shows another slot's document (src/controller/
	 * history.ts)
	 */
	function currentEntry(
		global: typeof globalThis,
	): (() => { key: string; id: string; url: string } | null) | null {
		try {
			const navigation = (global as { navigation?: object }).navigation;
			const entryProto = (
				global as unknown as { NavigationHistoryEntry?: { prototype: object } }
			).NavigationHistoryEntry?.prototype;
			if (!navigation || !entryProto) return null;
			const get = (from: object, name: string) =>
				Reflect.getOwnPropertyDescriptor(from, name)!.get!;
			const current = get(Reflect.getPrototypeOf(navigation)!, 'currentEntry');
			const key = get(entryProto, 'key');
			const id = get(entryProto, 'id');
			// (unforgeable: an own accessor of the object, which no script replaces)
			const location = global.location;
			const href = get(location, 'href');
			return () => {
				try {
					const entry = Reflect.apply(current, navigation, []) as object | null;
					if (!entry) return null;
					return {
						key: String(Reflect.apply(key, entry, [])),
						id: String(Reflect.apply(id, entry, [])),
						url: String(Reflect.apply(href, location, [])),
					};
				} catch (error) {
					return null;
				}
			};
		} catch (error) {
			return null;
		}
	}

	/**
	 * The window `_parent`, `_top` or `_unfencedtop` (`keyword`) names from
	 * a frame under the proxied top when that window shows a document of
	 * another slot, out of `client`'s reach (DocumentClient.targetWindow has
	 * no client to hand out). The browser would not navigate it for this
	 * frame either, for the reason targetWindow gives, so the hooks ask that
	 * window's inject to navigate itself (siteAcross.ts navigateAcross, a
	 * deferred part: it asks with the hub's token). Null otherwise, and for
	 * a sandboxed document, as targetWindow.
	 */
	function targetAcross(
		client: DocumentClient,
		keyword: string | null | undefined,
	): typeof globalThis | null {
		const name = (keyword ?? '').toLowerCase();
		if (name !== '_parent' && name !== '_top' && name !== '_unfencedtop')
			return null;
		return deferred('targetAcross')(client, name);
	}

	/**
	 * The sandbox a frame element of `client`'s document gives the frame's
	 * document (the page's attribute and the document's own flags), for its route (nestedMark): a document of another slot cannot
	 * read it. Null without a sandbox.
	 */
	function frameSandbox(
		client: DocumentClient,
		element: Element,
	): Set<string> | null {
		const sandbox = pageSandbox(element, markerPrefix());
		const own = client.sandboxFlags;
		if (sandbox === null) return own && new Set(own);
		const tokens = sandboxTokens(sandbox);
		return own
			? new Set([...tokens].filter((token) => own.has(token)))
			: tokens;
	}

	/**
	 * Whether the top-level document above this one sent COOP same-origin,
	 * as far as `client`'s document knows it (src/coop.ts): its own as its shell
	 * said it, the proxied top's, or, across a slot of the site pool, what
	 * its route says (partition.ts nestedMark)
	 */
	function topOpenerSameOrigin(client: DocumentClient): boolean {
		const top = client.proxiedTop;
		if (top !== client.global)
			try {
				return topOpenerSameOrigin(
					(top as Record<string, any>)[client.names.client] as DocumentClient,
				);
			} catch (error) {
				return false;
			}
		const mark = client.slotMark;
		if (mark) return mark.topOpenerSameOrigin;
		return client.scriptFacts.coop?.[0] === 'same-origin';
	}

	/**
	 * ScriptFacts.framed of `client`'s document, checked
	 */
	function framedOf(client: DocumentClient): ScriptFacts['framed'] | null {
		// as the shell gave it, checked (null for none)
		const told: unknown = client.scriptFacts.framed;
		if (typeof told !== 'object' || told === null) return null;
		const { policies, ancestors } = told as Record<string, unknown>;
		if (!Array.isArray(policies)) return null;
		const kept = policies.filter(
			(policy): policy is HopPolicy =>
				Array.isArray(policy) &&
				typeof policy[0] === 'string' &&
				Array.isArray(policy[1]) &&
				policy[1].every((source) => typeof source === 'string') &&
				(policy[2] === 'enforce' || policy[2] === 'report') &&
				typeof policy[3] === 'string',
		);
		return {
			policies: kept,
			...(Array.isArray(ancestors) &&
			ancestors.every((origin) => typeof origin === 'string')
				? { ancestors: ancestors as string[] }
				: {}),
		};
	}

	/**
	 * Post to `target` if it is a window of another site's origin
	 * (Context's postToRestricted), as `client`. The message goes
	 * to any origin, in an envelope that names this page's origin, the
	 * one it is for and the hub's token; the receiver's inject delivers it
	 * as from that origin when it is for its own, and drops it otherwise,
	 * as the browser does with the real origins
	 */
	function postAcross(
		client: DocumentClient,
		target: unknown,
		args: unknown[],
		cloneCheck: (args: unknown[]) => void,
	): boolean {
		const sites = client.sites;
		if (!sites || !isWindow(client, target)) return false;
		try {
			if (client.names.client in (target as object)) return false;
		} catch (error) {
			// another origin: the `in` check throws
		}
		catchRequiredArguments(args.length, 1, 'Window', 'postMessage');
		cloneCheck(args);
		const second = args[1];
		const options =
			typeof second === 'object' && second !== null
				? (second as WindowPostMessageOptions)
				: null;
		const requested = options ? options.targetOrigin : second;
		const transfer = options
			? Array.isArray(options.transfer)
				? options.transfer
				: []
			: Array.isArray(args[2])
				? (args[2] as Transferable[])
				: [];
		let to = requested === undefined ? '/' : String(requested);
		if (to === '/') to = client.origin;
		else if (to !== '*')
			try {
				to = new URL(to).origin;
			} catch (error) {
				throw invalidTargetOrigin(client.global, to);
			}
		// the window's own (cross-origin) postMessage: this realm's would
		// post to this window, whatever it is called on
		Reflect.apply(
			Reflect.get(target as object, 'postMessage') as Window['postMessage'],
			target,
			[
				{
					[client.names.globalName]: 'stompMessage',
					data: args[0],
					origin: client.origin,
					to,
					token: sites.token,
				},
				{ targetOrigin: '*', transfer },
			],
		);
		return true;
	}

	/**
	 * ContextModule's stand-in for a window of another slot's origin, one
	 * for every document of the module's origin in its frame tree, as
	 * for a proxied window of another origin without a pool (`standIns`,
	 * kept by the window itself, which this origin cannot reach here): a
	 * frame hands its same-origin parent's windows to its own code as they
	 * are, so `parent.parent` and `top` must be one object
	 */
	function restrictAcross(
		client: DocumentClient,
		module: ContextModule,
		context: typeof globalThis,
	): typeof globalThis {
		const restricted = module.restrictedNow(context);
		if (restricted !== undefined) return restricted;
		const domain = client.documentDomain;
		const key = standInKey(client);
		// the outermost document of this origin above this one
		let keeper: DocumentClient = client;
		for (let depth = 0; key !== null && depth < 64; depth++) {
			try {
				const parent = nativeParentOf(keeper.global) as typeof globalThis;
				if (parent === keeper.global) break;
				const above = (parent as Record<string, any>)[client.names.client] as
					DocumentClient | undefined;
				if (
					!above ||
					!('pool' in above) ||
					above.originKey !== client.originKey ||
					above.documentDomain !== domain
				)
					break;
				keeper = above;
			} catch (error) {
				// a parent of another origin
				break;
			}
		}
		// (made by the keeper's realm, which may outlive this one: see
		// keepStandIn)
		const entry = key === null ? undefined : keeper.standInEntry(key, context);
		return module.adopt(context, entry, keeper);
	}

	return {
		nativeParentOf,
		keepTopFocus,
		isHub,
		siteTop,
		slotAgentShare,
		slotShared,
		slotMarkOf,
		ancestorsPast,
		activationType,
		currentEntry,
		targetAcross,
		frameSandbox,
		topOpenerSameOrigin,
		framedOf,
		postAcross,
		restrictAcross,
	};
}
