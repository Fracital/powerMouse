// Runs inside dist/controllerFrame.html on the proxy origin. Owns the
// service worker registration, the transport and a StompController; the
// host application (a different origin) drives it over postMessage through
// RemoteController. Proxied frames are same-origin siblings of this frame, so
// it can read their location and drive their history on the host's behalf.
import type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
import { assetName } from '../config';
import type {
	ExtensionPromptAnswer,
	ExtensionPromptRequest,
	ExtensionsChange,
} from '../extensions/types';
import { helperNames } from '../helperNames';
import type { HookErrorInfo } from '../hooks';
import type { PasskeyAnswer, PasskeyPrompt } from '../passkeys/types';
import { constructTransport, resolveHttp3 } from '../transport/construct';
import type {
	IdentityChooserRequest,
	RequestInfo,
} from '../transport/messages';
import { RpcHelper } from '../transport/rpc';
import type { TransportNote } from '../transport/transportLog';
import type { CarrierInfo } from '../transport/wispWebTransport';
import { isApartAgent, outOfReach, runApartAgent } from './apart';
import { schemeOf } from './colorScheme';
import type { HubTabs } from './extensions';
import { shareGeometry } from './geometry';
import {
	answerRun,
	bindHistory,
	canTraverse,
	clientView,
	earlierWindows,
	noteActivation,
	noteBrowserNavigation,
	traverse,
} from './history';
import { StompController, type PermissionRequest } from './index';
import {
	ControllerFrameInit,
	FRAME_HELLO,
	FRAME_REFUSED,
	FrameBound,
	FrameRefusal,
	HostBound,
	REMOTE_RPC,
	StaleInfo,
	STORAGE_BLOCKED,
	TransportDescriptor,
} from './messages';

/** the host's frames as the extensions' tabs, asked over the frame's RPC */
function hostTabs(
	ask: (op: string, args: unknown[]) => Promise<unknown>,
): HubTabs {
	const call =
		<T>(op: string) =>
		(...args: unknown[]) =>
			ask(op, args) as Promise<T>;
	return {
		list: call('list'),
		ofClient: call('ofClient'),
		create: call('create'),
		navigate: call('navigate'),
		reload: call('reload'),
		back: call('back'),
		forward: call('forward'),
		close: call('close'),
		activate: call('activate'),
	};
}

/** the origins the frame's meta lists; none: it trusts whichever page embeds it */
function listedOrigins(): string[] {
	const meta = document.querySelector<HTMLMetaElement>(
		'meta[name="stomp-allowed-origins"]',
	);
	return (meta?.content || '').split(/\s+/).filter(Boolean);
}

/**
 * The embedding page's origin as this document can read it at load: the
 * parent's own (`location.ancestorOrigins`, which a referrer policy does not
 * hide in Chrome), else, in a browser without it, the referrer's. Null when
 * neither says (a host page whose Referrer-Policy is `no-referrer` or
 * `same-origin`): the page is asked (FRAME_HELLO), and the browser's origin
 * of its answer is the embedder's.
 */
function embedderOrigin(): string | null {
	const ancestors = location.ancestorOrigins;
	if (ancestors) {
		// 'null': an opaque parent, or one a referrer policy hides; its
		// answer to the hello says which
		const parent = ancestors[0];
		return parent && parent !== 'null' ? parent : null;
	}
	try {
		const origin = new URL(document.referrer).origin;
		return origin === 'null' ? null : origin;
	} catch (error) {
		return null;
	}
}

const listed = listedOrigins();

/** whether the frame serves a page of `origin`: one the meta lists, any page when it lists none, never an opaque one */
const allowed = (origin: string) =>
	origin !== 'null' && (!listed.length || listed.includes(origin));

/** refuse the embedding page: this frame says so, and so does the page's `wait()` */
function refuse(origin: string) {
	document.body.textContent = 'Embedding origin is not allowed.';
	const refusal: FrameRefusal = {
		reason: origin === 'null' ? 'opaque' : 'listed',
		origin,
	};
	window.parent.postMessage({ [FRAME_REFUSED]: refusal }, '*');
}

// the agent of the documents a Document-Isolation-Policy isolates, which
// runs this script too (./apart.ts)
if (isApartAgent()) runApartAgent();
else if (window === window.parent) {
	document.body.textContent =
		'This page is the Stomp controller frame; it only works embedded by a host application.';
} else {
	// the embedder's origin once it is known and allowed; until then the
	// frame says nothing to the page and hears nothing from it
	let hostOrigin = '';
	const atLoad = embedderOrigin();

	if (atLoad !== null && !allowed(atLoad)) {
		refuse(atLoad);
	} else {
		let controller: StompController | undefined;

		async function activated(registration: ServiceWorkerRegistration) {
			const worker =
				registration.active || registration.waiting || registration.installing;
			if (!worker) throw new Error('No service worker in registration');
			if (worker.state === 'activated') return worker;
			return new Promise<ServiceWorker>((resolve, reject) => {
				worker.addEventListener('statechange', () => {
					if (worker.state === 'activated') resolve(worker);
					else if (worker.state === 'redundant')
						reject(new Error('Service worker became redundant'));
				});
			});
		}

		/** the descriptor with its module URL resolved, refused off the proxy origin */
		function onProxyOrigin(
			descriptor: TransportDescriptor,
		): TransportDescriptor {
			const url = new URL(descriptor.module, location.href);
			if (url.origin !== location.origin)
				throw new Error('Transport modules must live on the proxy origin');
			const resolved = resolveHttp3(
				{ ...descriptor, module: url.href },
				location.href,
			);
			const http3 = resolved.http3;
			if (
				http3 &&
				http3 !== true &&
				http3.module &&
				new URL(http3.module).origin !== location.origin
			)
				throw new Error('The HTTP/3 module must live on the proxy origin');
			return resolved;
		}

		function loadTransport(
			descriptor: TransportDescriptor,
		): Promise<ProxyTransport> {
			return constructTransport(onProxyOrigin(descriptor));
		}

		/**
		 * A proxied frame is a same-origin sibling of this frame. The host
		 * addresses it by index into its `frames` list (indexed access on a
		 * cross-origin parent is allowed; named access is not).
		 */
		// the client's name on a proxied window: the controller's config's, once
		// the controller exists (the defaults until then)
		const clientName = () => helperNames(controller?.config).client;
		/** a proxied frame's window, its history told how to read its documents */
		function historyWindow(index: number) {
			const win = proxiedWindow(index);
			if (win)
				bindHistory(
					win,
					(target) => clientView(target, clientName()),
					earlierWindows(win, clientName()),
				);
			return win;
		}
		function proxiedWindow(index: number): (Window & typeof globalThis) | null {
			if (!Number.isInteger(index) || index < 0) return null;
			try {
				const win = window.parent[index] as
					(Window & typeof globalThis) | undefined;
				if (!win || win === window) return null;
				// same-origin with us, and one of ours (it has the client), or
				// still blank before its first navigation
				if (
					clientName() in (win as object) ||
					win.location.href === 'about:blank'
				)
					return win;
				return null;
			} catch (error) {
				return null; // cross-origin: not a proxied frame
			}
		}

		/**
		 * whether the host's frame at `index` may show a document of this
		 * origin out of this realm's reach (./apart.ts): a frame of the host
		 * the host asks about (one of its proxied frames) that refuses this
		 * realm
		 */
		function apartFrame(index: number): boolean {
			if (!controller || !Number.isInteger(index) || index < 0) return false;
			try {
				const win = window.parent[index] as Window | undefined;
				return !!win && win !== window && outOfReach(win);
			} catch (error) {
				return false;
			}
		}
		/** a frame the host addresses: its index, and the slot of the site pool its document reported from */
		function framed(asked: number | { index: number; origin?: string }) {
			return typeof asked === 'number'
				? { index: asked, origin: undefined }
				: {
						index: Number(asked?.index),
						origin:
							typeof asked?.origin === 'string' ? asked.origin : undefined,
					};
		}

		const rpc: RpcHelper<FrameBound, HostBound> = new RpcHelper<
			FrameBound,
			HostBound
		>(
			{
				init: async (init: ControllerFrameInit) => {
					let registration: ServiceWorkerRegistration;
					try {
						registration = await navigator.serviceWorker.register(
							`${init.directory}${assetName(init.assets, 'serviceWorker')}`,
							{ scope: init.directory, updateViaCache: 'none' },
						);
					} catch (error) {
						// a frame of another site than the top page gets no service
						// worker (and no other storage) where the browser blocks
						// third-party cookies; Chrome says only "The user denied
						// permission to use Service Worker"
						const access = await document
							.hasStorageAccess?.()
							.catch(() => true);
						if (access !== false) throw error;
						throw new Error(
							`${STORAGE_BLOCKED}: the browser blocks storage for ${location.origin} inside ${hostOrigin} (third-party cookies are blocked), so the proxy cannot register its service worker. Allow third-party cookies for ${new URL(hostOrigin).host}, or serve the host page and the proxy from one site.`,
							{ cause: error },
						);
					}
					// the controller waits for the worker to activate before its
					// first handshake, and is made now: the transport (its worker,
					// its module, the wisp carrier) starts while the service worker
					// installs, which on a first visit took longer than all of it
					const activating = activated(registration);
					activating.catch(() => {});
					// the site pool: the slots' origins, which frame one another's
					// documents (a frame of another site in a page), as the proxy
					// origin's and the host's do
					const slots = (init.sitePool ? init.sitePool.origins : [])
						.map((origin) => {
							try {
								return new URL(origin).origin;
							} catch (error) {
								return '';
							}
						})
						.filter((origin) => origin && origin !== location.origin);
					// the descriptor goes to the controller as it is: it hosts the
					// transport in its worker (or in this frame, `host: 'page'`)
					controller = new StompController({
						serviceworker: registration,
						transport: onProxyOrigin(init.transport),
						directory: init.directory,
						id: init.id,
						codec: init.codec,
						frameAncestors: slots.length
							? [hostOrigin, location.origin, ...slots]
							: [hostOrigin],
						// the hub of the site pool: the proxied frames are the
						// host page's, of the host's origin
						...(init.sitePool
							? { sitePool: init.sitePool, siteHost: hostOrigin }
							: { sitePool: false as const }),
						// (whose frames, this frame's siblings, the agent of the
						// documents out of its reach finds: ./apart.ts)
						framesUp: 1,
						onIsolationWanted: (client) =>
							void rpc.call('isolationWanted', client).catch(() => {}),
						openTab: !!init.openTab,
						// the extensions' tabs are the host's frames
						extensionTabs: hostTabs((op, args) =>
							rpc.call('extensionTabs', { op, args }),
						),
						// (the host page's, which it found out: nothing to ask here)
						hostReload: init.hostReload ?? null,
						...(init.cache === false ? { cache: false } : {}),
						...(init.allowInvalidJs === false ? { allowInvalidJs: false } : {}),
						...(init.membrane === false ? { membrane: false } : {}),
						...(init.serviceWorkers === false ? { serviceWorkers: false } : {}),
						...(typeof init.serviceWorkerTimeout === 'number'
							? { serviceWorkerTimeout: init.serviceWorkerTimeout }
							: {}),
						...(typeof init.serviceWorkerEventDelay === 'number'
							? { serviceWorkerEventDelay: init.serviceWorkerEventDelay }
							: {}),
						// numbers only: the controller clamps them
						...(typeof init.rewriteWorkers === 'number'
							? { rewriteWorkers: init.rewriteWorkers }
							: {}),
						...(typeof init.rewriteTimeout === 'number'
							? { rewriteTimeout: init.rewriteTimeout }
							: {}),
						...(init.rules ? { rules: init.rules } : {}),
						...(init.assets ? { assets: init.assets } : {}),
						...(init.adblock !== undefined ? { adblock: init.adblock } : {}),
						...(init.adblockLists ? { adblockLists: init.adblockLists } : {}),
						...(init.names ? { names: init.names } : {}),
						...(init.hooks ? { hooks: init.hooks } : {}),
						onHookError: (info: HookErrorInfo) => {
							rpc.call('hookError', info);
						},
						...(init.errorPage ? { errorPage: init.errorPage } : {}),
						...(init.fedcmTesting ? { fedcmTesting: true } : {}),
						// the host's page draws a site's FedCM account chooser
						identityRelay: async (
							request: IdentityChooserRequest,
							port: MessagePort,
						): Promise<number> =>
							(await rpc.call('identityChooser', { request, port }, [
								port,
							])) as number,
						// the Web Store's install and uninstall dialogs are the host page's
						extensionPromptRelay: async (
							request: ExtensionPromptRequest,
						): Promise<ExtensionPromptAnswer> =>
							(await rpc.call(
								'extensionPrompt',
								request,
							)) as ExtensionPromptAnswer,
						// a site's permission request the host asks the user about
						...(init.permissionPrompt
							? {
									onPermissionRequest: (
										request: PermissionRequest,
									): Promise<boolean | null> =>
										rpc.call('permission', {
											origin: request.origin,
											permission: request.permission,
											...(request.client ? { client: request.client } : {}),
										}),
								}
							: {}),
						// the host asks the user: every prompt goes on to it, with
						// the port that says the page gave up
						...(init.passkeys
							? {
									passkeyRelay: {
										config: {
											uv: init.passkeys.uv === true,
											testing: init.passkeys.testing === true,
										},
										// methods, not arrows: babel, which sorts the imports,
										// refuses a typed async arrow in a conditional's branch
										// (the file's imports went unchecked), and the return
										// types break rpc's circular inference
										async prompt(
											request: PasskeyPrompt,
											port: MessagePort,
										): Promise<PasskeyAnswer | null> {
											return (await rpc.call(
												'passkeyPrompt',
												{ request, port },
												[port],
											)) as PasskeyAnswer | null;
										},
										async focused(client: string): Promise<boolean> {
											return (
												(await rpc.call('passkeyFocused', client)) === true
											);
										},
									},
								}
							: {}),
						// the transport's notes go on the host's console, never this
						// frame's (the proxy origin's)
						debugTransport: init.debugTransport === true,
						onTransportNote: (note: TransportNote) => {
							rpc.call('transportNote', note);
						},
						// the host's request log travels SW -> here -> host
						...(init.requestLog
							? {
									onRequest: (info: RequestInfo) => {
										rpc.call('request', info);
									},
								}
							: {}),
					});
					// the extensions' hub tells the host what changed
					controller.addEventListener('extensions', (event) => {
						rpc.call(
							'extensionChange',
							(event as CustomEvent<ExtensionsChange>).detail,
						);
					});
					// the host mirrors `stale` and its two events
					controller.addEventListener('stale', (event) => {
						rpc.call('stale', (event as CustomEvent<StaleInfo>).detail);
					});
					controller.addEventListener('rebind', () => {
						rpc.call('stale', null);
					});
					// and every takeover of a newer service worker: the host's
					// frames send again a navigation it may have lost
					controller.onHandover(() => {
						rpc.call('handover', undefined);
					});
					// and `carrier`, with its event
					controller.addEventListener('carrier', (event) => {
						rpc.call('carrier', (event as CustomEvent<CarrierInfo>).detail);
					});
					// a worker that could not install is the host's error, as before
					await Promise.all([activating, controller.wait()]);
					return [
						{
							config: controller.config,
							stale: controller.stale,
							carrier: controller.carrier,
							sites: controller.siteOrigins,
						},
						[],
					];
				},
				route: async (url) => {
					if (!controller) throw new Error('Controller is not initialised');
					return [await controller.route(url), []];
				},
				siteOrigin: async (url) => {
					if (!controller) throw new Error('Controller is not initialised');
					return [await controller.siteOrigin(url), []];
				},
				unroute: async (url) => {
					if (!controller) throw new Error('Controller is not initialised');
					return [await controller.unroute(url), []];
				},
				suggest: async ({ text, engine, endpoint, limit }) => {
					if (!controller) throw new Error('Controller is not initialised');
					return [
						await controller.suggest(text, { engine, endpoint, limit }),
						[],
					];
				},
				// kept here, and by every slot's agent, for the documents of
				// their origins (./geometry.ts)
				geometry: async (geometry) => {
					if (controller) await controller.shareGeometry(geometry);
					else shareGeometry(window, geometry);
					return [null, []];
				},
				viewport: async ([width, height, origin, colorScheme]) => {
					if (typeof origin === 'string' && controller?.siteOriginKnown(origin))
						await controller.siteViewport(
							origin,
							Number(width),
							Number(height),
							schemeOf(colorScheme),
						);
					else
						controller?.reportViewport(
							Number(width),
							Number(height),
							schemeOf(colorScheme),
						);
					return [null, []];
				},
				setTransport: async (descriptor) => {
					if (!controller) throw new Error('Controller is not initialised');
					// the worker swaps by descriptor; a page-hosted transport (the
					// host asked for it, or the worker fell back) takes an instance
					if (controller.transportHost === 'worker')
						await controller.setTransport(onProxyOrigin(descriptor));
					else await controller.setTransport(await loadTransport(descriptor));
				},
				frameInfo: async (asked) => {
					const { index, origin } = framed(asked);
					const win = historyWindow(index);
					if (!win) {
						// the site pool: a document of a slot, which its agent reads;
						// a document of this origin out of this realm's reach, the
						// agent of its cluster (./apart.ts)
						const info =
							origin && controller?.siteOriginKnown(origin)
								? await controller.siteFrameInfo(origin, index)
								: apartFrame(index)
									? await controller!.apartInfo([index])
									: null;
						return [
							info ?? {
								url: null,
								title: null,
								canGoBack: null,
								canGoForward: null,
							},
							[],
						];
					}
					const client = (
						win as unknown as Record<string, { url?: { toString(): string } }>
					)[clientName()];
					return [
						{
							url: client?.url ? client.url.toString() : null,
							title: win.document?.title ?? null,
							canGoBack: canTraverse(win, 'back'),
							canGoForward: canTraverse(win, 'forward'),
						},
						[],
					];
				},
				clearCache: async () => {
					if (!controller) throw new Error('Controller is not initialised');
					await controller.clearCache();
				},
				rules: async (rules) => {
					if (!controller) throw new Error('Controller is not initialised');
					await controller.setRules(rules);
				},
				dnr: async (command) => {
					if (!controller) throw new Error('Controller is not initialised');
					return [await controller.dnr(command), []];
				},
				shields: async (list) => {
					if (!controller) throw new Error('Controller is not initialised');
					controller.shields.replace(list);
				},
				adblock: async ({ lists }) => {
					if (!controller) throw new Error('Controller is not initialised');
					return [await controller.setAdblockLists(lists), []];
				},
				adblockRefresh: async () => {
					if (!controller) throw new Error('Controller is not initialised');
					return [await controller.refreshAdblockLists(), []];
				},
				cookies: async (command) => {
					if (!controller) throw new Error('Controller is not initialised');
					return [await controller.cookieCommand(command), []];
				},
				forgetStorage: async (origin) => {
					if (!controller) throw new Error('Controller is not initialised');
					await controller.forgetStorage(origin);
				},
				passkeys: async (command) => {
					if (!controller) throw new Error('Controller is not initialised');
					return [await controller.passkeyCommand(command), []];
				},
				goneClients: async (clients) => {
					if (!controller) throw new Error('Controller is not initialised');
					return [await controller.goneClients(clients), []];
				},
				extensions: async ({ call, args }) => {
					if (!controller) throw new Error('Controller is not initialised');
					return [await controller.extensionCall(call, args), []];
				},
				frameActivated: async ({ index, token, nested, origin }) => {
					const win = historyWindow(index);
					if (!win && origin && controller?.siteOriginKnown(origin))
						await controller.siteActivated(
							origin,
							index,
							String(token),
							nested === true,
						);
					else if (!win && apartFrame(index))
						controller!.apartActivated([index], String(token), nested === true);
					else noteActivation(win, String(token), nested === true);
					return [null, []];
				},
				frameHistory: async ({ index, origin, run, op }) => {
					if (!controller) return [null, []];
					// the site pool: what every agent (and this realm) keeps of the
					// frame's runs
					if (origin === '*') {
						if (op.kind !== 'expect') return [null, []];
						controller.siteTell(Number(index), op);
						origin = location.origin;
					}
					if (controller.siteOriginKnown(origin))
						return [
							await controller.siteHistory(origin, Number(index), run, op),
							[],
						];
					if (origin !== location.origin) return [null, []];
					// a run of this origin's (a site shown without the pool): the
					// host's frame, which is this frame's sibling
					let win: Window | undefined;
					try {
						win = window.parent[Number(index)] as Window | undefined;
					} catch (error) {
						// a frame that went away
					}
					return [
						win && win !== window
							? await answerRun(win, run, op, clientName())
							: null,
						[],
					];
				},
				frameCommand: async ({ index, command, origin, routed }) => {
					const win = historyWindow(index);
					if (!win) {
						// a document of this origin out of this realm's reach: the
						// agent of its cluster steps it (./apart.ts)
						if (
							apartFrame(index) &&
							!(origin && controller?.siteOriginKnown(origin))
						) {
							const done =
								(await controller!.apartCommand([index], command)) === true;
							// (the worker hears of a typed address only where the
							// agent reached the document it leaves: a new tab still
							// on the host's about:blank is navigated as before)
							if (done && command === 'typed' && routed)
								await controller?.typed(routed).catch(() => {});
							return [done, []];
						}
						// the site pool: a document of a slot, stepped by its agent
						if (!origin || !controller?.siteOriginKnown(origin))
							return [false, []];
						return [
							(await controller.siteCommand(origin, index, command)) === true,
							[],
						];
					}
					if (command === 'typed') {
						noteBrowserNavigation(win);
						if (routed) await controller?.typed(routed).catch(() => {});
						return [true, []];
					}
					if (command === 'reload') {
						noteBrowserNavigation(win);
						win.location.reload();
						return [true, []];
					}
					return [await traverse(win, command), []];
				},
			},
			REMOTE_RPC,
			(data, transfer) => window.parent.postMessage(data, hostOrigin, transfer),
		);

		let answered = false;
		/** the embedder's origin is known: serve the page, or refuse it */
		const meet = (origin: string) => {
			if (!allowed(origin)) return refuse(origin);
			hostOrigin = origin;
			rpc.call('ready', undefined);
		};
		window.addEventListener('message', (event) => {
			if (event.source !== window.parent) return;
			// the page's answer to the hello: the browser says its origin
			if (!hostOrigin && atLoad === null) {
				const data = event.data as Record<string, unknown> | null;
				if (!answered && data?.[FRAME_HELLO] === true) {
					answered = true;
					meet(event.origin);
				}
				return;
			}
			if (!hostOrigin || event.origin !== hostOrigin) return;
			rpc.receive(event.data);
		});

		if (atLoad !== null) meet(atLoad);
		else window.parent.postMessage({ [FRAME_HELLO]: true }, '*');
	}
}
