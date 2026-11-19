// The gesture-gated calls of a document's realm, answering as with no
// activation while the browser's is explained only by one the document got
// through the proxy, and the walk of the page's frames an input event
// makes (./activation.ts). A deferred statement (./activationPart.ts),
// evaluated in the proxied top's realm, once a tab: a document under it
// calls the top's functions with its own client, which make and answer
// with its realm's objects (its DOMException, its Promise, its Proxy
// module's wrappers, the wrappers' bodies of its own bundle), so they keep
// nothing of the top's realm. Its top level reads no global
// (./deferredParts.ts).
import type ProxyModule from '../modules/Proxy';
import { withStack } from '../nativeErrors';
import {
	activationState,
	LIFESPAN,
	nativeLength,
	type GateBody,
} from './activation';
import type DocumentClient from './Client';
import { reachableClients } from './modules/Context';
import { siteWindows } from './siteWindows';

/** what one document's input walks the frames for at most, in a burst of input */
const WALK_GAP = 100;

/**
 * One gated member: `member` of the prototype of the realm's interface
 * `owner` (of the window itself when `owner` is ''), refused (`refused`
 * answers) when `when` holds; `kind` says what makes its wrapper ask: 1 a
 * transient activation the browser has and the document has not, 2 likewise
 * a sticky one, 0 any call. The interface is named, not read: a realm makes
 * an interface the first time anything reads its name (about half a KB
 * each)
 */
type Gate = (
	owner: string,
	member: string,
	when: (that: any, args: any[]) => boolean,
	refused: (that: any, args: any[]) => unknown,
	own?: boolean,
	kind?: number,
) => void;

/** the navigator member a page reaches the interface `owner`'s object by, if that is the only way */
const navigatorMember = (owner: string) =>
	owner === 'Clipboard'
		? 'clipboard'
		: owner === 'USB'
			? 'usb'
			: owner === 'HID'
				? 'hid'
				: owner === 'Serial'
					? 'serial'
					: owner === 'Bluetooth'
						? 'bluetooth'
						: '';

/** the interface whose object navigator member `member` is */
const interfaceOf = (member: string) =>
	member === 'clipboard'
		? 'Clipboard'
		: member === 'usb'
			? 'USB'
			: member === 'hid'
				? 'HID'
				: member === 'serial'
					? 'Serial'
					: 'Bluetooth';

/** where `owner`'s gated members are in `global` (the window itself for '') */
const targetOf = (global: Record<string, any>, owner: string) =>
	owner ? global[owner]?.prototype : global;

/** the gated members of `client`'s realm, each handed to `gate` */
function rules(client: DocumentClient, gate: Gate) {
	const global = client.global as typeof globalThis & Record<string, any>;
	// from the proxy alone: a transient activation the browser has and the
	// document has not natively, a sticky one likewise
	const transient = () => (activationState(client) & 5) === 4;
	const sticky = () => (activationState(client) & 10) === 8;
	const PagePromise = global.Promise as PromiseConstructor;
	const reject = (error: unknown) =>
		Reflect.apply(PagePromise.reject, PagePromise, [error]) as Promise<never>;
	const domException = (message: string, name: string) =>
		withStack(new global.DOMException(message, name));
	const failed = (member: string, owner: string, message: string) =>
		`Failed to execute '${member}' on '${owner}': ${message}`;
	// Element.requestFullscreen() (Chrome rejects with no activation as it
	// does where a policy refuses it), and the prefixed names
	gate('Element', 'requestFullscreen', transient, () =>
		reject(withStack(new global.TypeError('Permissions check failed'))),
	);
	for (const name of ['webkitRequestFullscreen', 'webkitRequestFullScreen'])
		gate('Element', name, transient, () => undefined);
	// pointer lock (a sandbox without allow-pointer-lock refuses first)
	gate(
		'Element',
		'requestPointerLock',
		() =>
			transient() &&
			(client.sandboxFlags === null || client.allows('allow-pointer-lock')),
		() =>
			reject(
				domException(
					'A user gesture is required to request Pointer Lock.',
					'NotAllowedError',
				),
			),
	);
	gate('PresentationRequest', 'start', transient, () =>
		reject(
			domException(
				failed(
					'start',
					'PresentationRequest',
					'PresentationRequest::start() requires user gesture.',
				),
				'InvalidAccessError',
			),
		),
	);
	// the file pickers: a sandboxed document's and a frame of another
	// origin than its top's are refused before the activation is looked
	// at (the browser sees one origin), then one with no activation
	const opaque = client.sandboxedOpaque;
	const crossFrame = () =>
		client.proxiedTop !== global && client.origin !== client.topOrigin;
	for (const name of [
		'showOpenFilePicker',
		'showSaveFilePicker',
		'showDirectoryPicker',
	])
		gate(
			'',
			name,
			() => opaque || crossFrame() || (activationState(client) & 1) === 0,
			() =>
				reject(
					domException(
						failed(
							name,
							'Window',
							opaque
								? "Sandboxed documents aren't allowed to show a file picker."
								: crossFrame()
									? "Cross origin sub frames aren't allowed to show a file picker."
									: 'Must be handling a user gesture to show a file picker.',
						),
						'SecurityError',
					),
				),
			true,
			0,
		);
	gate(
		'HTMLInputElement',
		'showPicker',
		(that: HTMLInputElement) => transient() && !that.disabled && !that.readOnly,
		() => {
			throw domException(
				failed(
					'showPicker',
					'HTMLInputElement',
					'HTMLInputElement::showPicker() requires user activation.',
				),
				'NotAllowedError',
			);
		},
	);
	// navigator.vibrate() needs a sticky activation
	gate(
		'Navigator',
		'vibrate',
		(_that, args) => args.length > 0 && sticky(),
		() => false,
		false,
		2,
	);
	gate('Navigator', 'share', transient, () =>
		reject(
			domException(
				failed(
					'share',
					'Navigator',
					'Must be handling a user gesture to perform a share request.',
				),
				'NotAllowedError',
			),
		),
	);
	gate('EyeDropper', 'open', transient, () =>
		reject(
			domException(
				failed(
					'open',
					'EyeDropper',
					'EyeDropper::open() requires user gesture.',
				),
				'NotAllowedError',
			),
		),
	);
	// copying and cutting by a command need a transient activation
	gate(
		'Document',
		'execCommand',
		(_that, args) => /^(copy|cut)$/i.test(String(args[0])) && transient(),
		() => false,
	);
	for (const name of ['writeText', 'write'])
		gate(
			'Clipboard',
			name,
			(_that, args) =>
				args.length > 0 && transient() && global.document.hasFocus(),
			() =>
				reject(
					domException(
						failed(name, 'Clipboard', 'Write permission denied.'),
						'NotAllowedError',
					),
				),
		);
	// a popup the browser opens: its blocker refuses one with no
	// activation. Not a URL the host opens as a tab (DOMHooks' open):
	// ./windowOpen.ts decides that one as the blocker would
	gate(
		'',
		'open',
		(_that, args) => {
			// an activation an input event elsewhere gave (a document that
			// starts with one, after a typed URL or a link of another site,
			// keeps the browser's popup decision: its blocker cannot be
			// asked without an activation, and with no blocker every popup
			// opens natively)
			if (
				!transient() ||
				Date.now() - (client.activation?.input ?? -Infinity) >= LIFESPAN
			)
				return false;
			const name = args[1] === undefined ? '' : String(args[1]);
			// a window or frame named (an existing one natively needs no
			// activation), and the targets of the document's own: the
			// browser's
			if (name !== '' && name.toLowerCase() !== '_blank') return false;
			let routable = false;
			try {
				routable =
					args[0] !== undefined &&
					String(args[0]) !== '' &&
					/^https?:$/.test(
						client.encodingParse(String(args[0]), client.baseHref).protocol,
					);
			} catch (error) {
				// no URL: the browser's
			}
			const tab =
				client.config.openTab &&
				routable &&
				(client.sandboxFlags === null ||
					(client.allows('allow-popups') &&
						client.allows('allow-popups-to-escape-sandbox')));
			return !tab;
		},
		() => null,
		true,
	);
	// the device choosers
	// (a missing argument is the bindings' TypeError first)
	for (const [owner, name, label, arity] of [
		['USB', 'requestDevice', 'USB', 1],
		['HID', 'requestDevice', 'HID', 1],
		['Serial', 'requestPort', 'Serial', 0],
		['Bluetooth', 'requestDevice', 'Bluetooth', 0],
	] as const)
		gate(
			owner,
			name,
			(_that, args) => args.length >= arity && transient(),
			() =>
				reject(
					domException(
						failed(
							name,
							label,
							'Must be handling a user gesture to show a permission request.',
						),
						'SecurityError',
					),
				),
		);
	// picture-in-picture: a video without metadata is refused first
	gate(
		'HTMLVideoElement',
		'requestPictureInPicture',
		(that: HTMLVideoElement) =>
			transient() &&
			that.readyState !== 0 &&
			!that.hasAttribute('disablepictureinpicture'),
		() =>
			reject(
				domException(
					failed(
						'requestPictureInPicture',
						'HTMLVideoElement',
						"Must be handling a user gesture if there isn't already an element in Picture-in-Picture.",
					),
					'NotAllowedError',
				),
			),
	);
	gate(
		'DocumentPictureInPicture',
		'requestWindow',
		() => transient() && client.proxiedTop === global,
		() =>
			reject(
				domException(
					failed(
						'requestWindow',
						'DocumentPictureInPicture',
						'Document PiP requires user activation',
					),
					'NotAllowedError',
				),
			),
	);
	// autoplay with sound: natively the document, or one above it that
	// it may play for (of its origin, or framed with allow="autoplay"),
	// must have had an activation
	const playsFor = () => {
		for (
			let current: DocumentClient | undefined = client, depth = 0;
			current && depth < 64;
			depth++
		) {
			if (activationState(current) & 2) return true;
			let element: Element | null = null;
			let parent: DocumentClient | undefined;
			try {
				element = current.nativeFrameElement();
				parent = (current.parent as Record<string, any>)[
					client.names.client
				] as DocumentClient | undefined;
			} catch (error) {
				// a parent of another real origin: the host's
			}
			if (!element || !parent || parent === current) return false;
			if (
				!/\bautoplay\b/i.test(element.getAttribute('allow') ?? '') &&
				(current.sandboxedOpaque ||
					parent.sandboxedOpaque ||
					parent.origin !== current.origin)
			)
				return false;
			current = parent;
		}
		return false;
	};
	gate(
		'HTMLMediaElement',
		'play',
		(that: HTMLMediaElement) => !that.muted && sticky() && !playsFor(),
		() =>
			reject(
				domException(
					"play() failed because the user didn't interact with the document first. https://goo.gl/xX8pDD",
					'NotAllowedError',
				),
			),
		false,
		2,
	);
}

/** whether `that` inherits from `target` (the native's own brand check answers anything else) */
function branded(that: unknown, target: object) {
	try {
		for (
			let proto =
					typeof that === 'object' && that !== null
						? Reflect.getPrototypeOf(that)
						: null,
				depth = 0;
			proto !== null && depth < 64;
			proto = Reflect.getPrototypeOf(proto), depth++
		)
			if (proto === target) return true;
	} catch (error) {
		// a proxy's trap threw: the native's
	}
	return false;
}

/**
 * Hooks `client`'s realm's gated members (once: ./activation.ts
 * markActivation) with `proxyModule`'s wrappers (the realm's) whose bodies
 * `body` makes in the realm: each calls the native unless the activation
 * its kind asks about is the proxy's alone, and then `gated`. A member of
 * an interface a page reaches only by a navigator member (the clipboard,
 * the device APIs) it was not handed yet is hooked when it is: the
 * navigator member's getter is, and the object's prototype's members then
 */
export function activationGates(
	client: DocumentClient,
	proxyModule: ProxyModule,
	bodies: GateBody[],
) {
	const global = client.global as typeof globalThis & Record<string, any>;
	const note = client.activation;
	if (note) note.wrap = [proxyModule, bodies];
	const wrap = (target: any, member: string, kind: number) => {
		const native = target?.[member];
		if (typeof native === 'function')
			target[member] = proxyModule.wrapFunction(native, bodies[kind]);
	};
	try {
		// navigator.userActivation answers as natively
		const proto = global.UserActivation?.prototype;
		for (const name of ['isActive', 'hasBeenActive']) {
			const descriptor = proto && Reflect.getOwnPropertyDescriptor(proto, name);
			if (!descriptor?.get) continue;
			Reflect.defineProperty(proto, name, {
				...descriptor,
				get: proxyModule.wrapFunction(
					descriptor.get,
					bodies[name === 'isActive' ? 1 : 2],
				),
			});
		}
		const handed = client.permissionHooks?.done;
		const navigator = global.Navigator?.prototype;
		const reaching: string[] = [];
		rules(client, (owner, member, _when, _refused, _own, kind = 1) => {
			// a frame's Document Picture-in-Picture request is the browser's
			// to refuse (only a top opens one)
			if (owner === 'DocumentPictureInPicture' && client.proxiedTop !== global)
				return;
			const via = navigatorMember(owner);
			if (via && !handed?.includes(via)) {
				if (reaching.includes(via)) return;
				reaching.push(via);
				const descriptor =
					navigator && Reflect.getOwnPropertyDescriptor(navigator, via);
				if (descriptor?.get)
					Reflect.defineProperty(navigator, via, {
						...descriptor,
						get: proxyModule.wrapFunction(descriptor.get, bodies[0]),
					});
				return;
			}
			wrap(targetOf(global, owner), member, kind);
		});
	} catch (error) {
		// a realm going away
	}
}

/** the members of the interface of `object`, navigator member `via` of `client`'s page, hooked once */
function reached(client: DocumentClient, via: string, object: object) {
	const note = client.activation;
	if (!note?.wrap || note.reached?.includes(via)) return;
	(note.reached ??= []).push(via);
	const [proxyModule, bodies] = note.wrap;
	const owner = interfaceOf(via);
	const target = Reflect.getPrototypeOf(object) as Record<string, any> | null;
	rules(client, (name, member, _when, _refused, _own, kind = 1) => {
		if (name !== owner || !target) return;
		const native = target[member];
		if (typeof native === 'function')
			target[member] = proxyModule.wrapFunction(native, bodies[kind]);
	});
}

/**
 * A call of a gated member (`fn` its native, told by its name and the
 * receiver's interface) in `client`'s realm while the activation it needs
 * is the proxy's alone: Chrome's refusal where its rule says so, else the
 * native's answer (and for a navigator member's getter, the object, its
 * interface's members hooked)
 */
export function gated(
	client: DocumentClient,
	fn: Function,
	that: unknown,
	args: unknown[],
) {
	const name = String(Reflect.getOwnPropertyDescriptor(fn, 'name')?.value);
	if (name.startsWith('get ')) {
		const value = Reflect.apply(fn, that, args) as unknown;
		const member = name.slice(4);
		if (member === 'isActive' || member === 'hasBeenActive')
			return value === true && that === client.historyActivation?.natives?.[2]
				? (activationState(client) & (member === 'isActive' ? 1 : 2)) !== 0
				: value;
		try {
			if (typeof value === 'object' && value !== null)
				reached(client, member, value);
		} catch (error) {
			// a realm going away
		}
		return value;
	}
	const global = client.global as typeof globalThis & Record<string, any>;
	// a call on the window (or with none) is a window member's
	const onWindow = that === undefined || that === null || that === global;
	let refusal: ((that: any, args: any[]) => unknown) | null = null;
	let found = false;
	rules(client, (owner, member, when, refused) => {
		if (found || member !== name || (owner === '') !== onWindow) return;
		const target = targetOf(global, owner);
		if (!target || (owner && !branded(that, target))) return;
		found = true;
		if (when(that, args)) refusal = refused;
	});
	return refusal
		? (refusal as (that: unknown, args: unknown[]) => unknown)(that, args)
		: Reflect.apply(fn, that, args);
}

/**
 * An input event that activates (the Navigate module filtered it) in
 * `client`'s document: every proxied document of the page is told whether
 * the activation is its own natively (./activation.ts noteInput)
 */
export function walkInput(client: DocumentClient) {
	const now = Date.now();
	const note = client.activation;
	if (note && now - note.walked < WALK_GAP) {
		note.own = now;
		return;
	}
	let top: Window;
	let proxiedTop: unknown;
	try {
		top = client.top as unknown as Window;
		proxiedTop = client.proxiedTop;
	} catch (error) {
		return;
	}
	const names = client.names.client;
	const clientOf = (context: unknown): DocumentClient | undefined => {
		try {
			const found = (context as Record<string, unknown>)[names] as
				DocumentClient | undefined;
			return found?.global === context ? found : undefined;
		} catch (error) {
			// a window of another real origin
			return undefined;
		}
	};
	// the input's frame and its ancestors in the proxied page
	const ancestors = new Set<unknown>();
	for (
		let current: DocumentClient | undefined = client, depth = 0;
		current && depth < 64;
		depth++
	) {
		ancestors.add(current.global);
		let parent: unknown;
		try {
			parent = current.parent;
		} catch (error) {
			break;
		}
		if (parent === current.global) break;
		current = clientOf(parent);
	}
	// (the site pool: an ancestor of another slot's origin is one too, and
	// so are those past it, which this document reaches by the browser's
	// own parent of each)
	const sites = client.sites;
	if (sites)
		for (let context: unknown = client.global, depth = 0; depth < 64; depth++) {
			const parent = siteWindows().nativeParentOf(context);
			if (!parent || parent === context) break;
			ancestors.add(parent);
			context = parent;
		}
	// the top of the proxied world a document of another slot's frame tree
	// is in (the site pool: a frame of another slot, between, hides the
	// proxied top from a document under it)
	const worldOf = (other: DocumentClient) =>
		sites
			? siteWindows().siteTop(other.global, sites.hub, client.global)
			: other.proxiedTop;
	const world = sites ? worldOf(client) : proxiedTop;
	const opaque = client.sandboxedOpaque;
	let budget = 2000;
	const visit = (context: Window) => {
		if (budget-- <= 0) return;
		const other = clientOf(context);
		if (other?.markActivation) {
			let own = ancestors.has(context);
			if (!own)
				try {
					own =
						!opaque &&
						!other.sandboxedOpaque &&
						(other.proxiedTop === proxiedTop || worldOf(other) === world) &&
						reachableClients(client, other);
				} catch (error) {
					// no origin to compare: another origin's
				}
			try {
				other.markActivation(other, !own, now);
			} catch (error) {
				// a document going away
			}
		}
		let length = 0;
		try {
			length = nativeLength
				? (Reflect.apply(nativeLength, context, []) as number)
				: context.length;
		} catch (error) {
			try {
				length = context.length;
			} catch (error) {
				// a window that is closing
			}
		}
		for (let index = 0; index < length && budget > 0; index++) {
			let child: Window | undefined;
			try {
				child = (context as unknown as Record<number, Window>)[index];
			} catch (error) {
				// gone meanwhile
			}
			if (child) visit(child);
		}
	};
	visit(top);
	if (client.activation) client.activation.walked = now;
}
