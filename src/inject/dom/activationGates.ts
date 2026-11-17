// The gesture-gated calls of a document's realm, answering as with no
// activation while the browser's is explained only by one the document got
// through the proxy (./activation.ts, which makes them the first time one
// reaches it). A deferred statement (./activationPart.ts): most documents
// never get such an activation. Its top level reads no global (./deferredParts.ts).
import ProxyModule from '../modules/Proxy';
import { withStack } from '../nativeErrors';
import { activationState, LIFESPAN, nativeLength } from './activation';
import type DocumentClient from './Client';
import { reachableClients } from './modules/Context';

/** what one document's input walks the frames for at most, in a burst of input */
const WALK_GAP = 100;

/** makes `client`'s realm's gates (once: ./activation.ts markActivation) */
export function activationGates(client: DocumentClient) {
	const global = client.global as typeof globalThis & Record<string, any>;
	const proxyModule = client.getModule(ProxyModule)!;
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
	/**
	 * `owner.prototype[member]` refusing (`refused` answers) when `when`
	 * holds, for a receiver that inherits from the prototype (anything else,
	 * the prototype itself included, meets the native's own brand check
	 * first, as natively)
	 */
	const gate = (
		owner:
			{ prototype?: Record<string, any> } | Record<string, any> | undefined,
		member: string,
		when: (that: any, args: any[]) => boolean,
		refused: (that: any, args: any[]) => unknown,
		own = false,
	) => {
		const target = own ? owner : (owner as { prototype?: object })?.prototype;
		const native = (target as Record<string, any> | undefined)?.[member];
		if (typeof native !== 'function') return;
		const branded = (that: unknown) => {
			if (own) return true;
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
		};
		(target as Record<string, any>)[member] = proxyModule.wrapFunction(
			native,
			(fn, that, args) =>
				branded(that) && when(that, args)
					? refused(that, args)
					: Reflect.apply(fn, that, args),
		);
	};
	try {
		// navigator.userActivation answers as natively
		const proto = global.UserActivation?.prototype;
		for (const [name, bit] of [
			['isActive', 1],
			['hasBeenActive', 2],
		] as const) {
			const descriptor = proto && Reflect.getOwnPropertyDescriptor(proto, name);
			if (!descriptor?.get) continue;
			Reflect.defineProperty(proto, name, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (fn, that, args) => {
					const value = Reflect.apply(fn, that, args);
					return value === true &&
						that === client.historyActivation?.natives?.[2]
						? (activationState(client) & bit) !== 0
						: value;
				}),
			});
		}
		// Element.requestFullscreen() (Chrome rejects with no activation as it
		// does where a policy refuses it), and the prefixed names
		gate(global.Element, 'requestFullscreen', transient, () =>
			reject(withStack(new global.TypeError('Permissions check failed'))),
		);
		for (const name of ['webkitRequestFullscreen', 'webkitRequestFullScreen'])
			gate(global.Element, name, transient, () => undefined);
		// pointer lock (a sandbox without allow-pointer-lock refuses first)
		gate(
			global.Element,
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
		gate(global.PresentationRequest, 'start', transient, () =>
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
				global,
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
			);
		gate(
			global.HTMLInputElement,
			'showPicker',
			(that: HTMLInputElement) =>
				transient() && !that.disabled && !that.readOnly,
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
			global.Navigator,
			'vibrate',
			(_that, args) => args.length > 0 && sticky(),
			() => false,
		);
		gate(global.Navigator, 'share', transient, () =>
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
		if (typeof global.EyeDropper === 'function')
			gate(global.EyeDropper, 'open', transient, () =>
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
			global.Document,
			'execCommand',
			(_that, args) => /^(copy|cut)$/i.test(String(args[0])) && transient(),
			() => false,
		);
		for (const name of ['writeText', 'write'])
			gate(
				global.Clipboard,
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
		// that is the host's to decide
		gate(
			global,
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
							client.encodingParse(String(args[0]), client.baseURL.toString())
								.protocol,
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
			[global.USB, 'requestDevice', 'USB', 1],
			[global.HID, 'requestDevice', 'HID', 1],
			[global.Serial, 'requestPort', 'Serial', 0],
			[global.Bluetooth, 'requestDevice', 'Bluetooth', 0],
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
			global.HTMLVideoElement,
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
			global.DocumentPictureInPicture,
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
			global.HTMLMediaElement,
			'play',
			(that: HTMLMediaElement) => !that.muted && sticky() && !playsFor(),
			() =>
				reject(
					domException(
						"play() failed because the user didn't interact with the document first. https://goo.gl/xX8pDD",
						'NotAllowedError',
					),
				),
		);
	} catch (error) {
		// a realm going away
	}
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
						other.proxiedTop === proxiedTop &&
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
