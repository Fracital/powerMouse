// Runs inside dist/controllerFrame.html on the proxy origin. Owns the
// service worker registration, the transport and a StompController; the
// host application (a different origin) drives it over postMessage through
// RemoteController. Proxied frames are same-origin siblings of this frame, so
// it can read their location and drive their history on the host's behalf.
import type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
import { assetName } from '../config';
import { helperNames } from '../helperNames';
import type { HookErrorInfo } from '../hooks';
import { constructTransport, resolveHttp3 } from '../transport/construct';
import type { RequestInfo } from '../transport/messages';
import { RpcHelper } from '../transport/rpc';
import {
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
	FrameBound,
	HostBound,
	REMOTE_RPC,
	StaleInfo,
	STORAGE_BLOCKED,
	TransportDescriptor,
} from './messages';

function allowedOrigins(): string[] {
	const meta = document.querySelector<HTMLMetaElement>(
		'meta[name="stomp-allowed-origins"]',
	);
	const listed = (meta?.content || '').split(/\s+/).filter(Boolean);
	if (listed.length) return listed;
	// trust the page that embedded us, decided once at load
	try {
		return [new URL(document.referrer).origin];
	} catch (error) {
		return [];
	}
}

const origins = allowedOrigins();

if (window === window.parent || !origins.length) {
	document.body.textContent =
		'This page is the Stomp controller frame; it only works embedded by a host application.';
} else {
	const hostOrigin = origins.includes(new URL(document.referrer).origin)
		? new URL(document.referrer).origin
		: null;

	if (!hostOrigin) {
		document.body.textContent = 'Embedding origin is not allowed.';
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

		const rpc = new RpcHelper<FrameBound, HostBound>(
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
					const serviceworker = await activated(registration);
					// the descriptor goes to the controller as it is: it hosts the
					// transport in its worker (or in this frame, `host: 'page'`)
					controller = new StompController({
						serviceworker,
						transport: onProxyOrigin(init.transport),
						directory: init.directory,
						id: init.id,
						codec: init.codec,
						frameAncestors: [hostOrigin],
						openTab: !!init.openTab,
						// (the host page's, which it found out: nothing to ask here)
						hostReload: init.hostReload ?? null,
						...(init.cache === false ? { cache: false } : {}),
						...(init.allowInvalidJs === false ? { allowInvalidJs: false } : {}),
						...(init.membrane === false ? { membrane: false } : {}),
						...(init.serviceWorkers === false ? { serviceWorkers: false } : {}),
						...(init.rewriter === 'wasm' ? { rewriter: 'wasm' } : {}),
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
						...(init.names ? { names: init.names } : {}),
						...(init.hooks ? { hooks: init.hooks } : {}),
						onHookError: (info: HookErrorInfo) => {
							rpc.call('hookError', info);
						},
						...(init.errorPage ? { errorPage: init.errorPage } : {}),
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
						// the host's request log travels SW -> here -> host
						...(init.requestLog
							? {
									onRequest: (info: RequestInfo) => {
										rpc.call('request', info);
									},
								}
							: {}),
					});
					// the host mirrors `stale` and its two events
					controller.addEventListener('stale', (event) => {
						rpc.call('stale', (event as CustomEvent<StaleInfo>).detail);
					});
					controller.addEventListener('rebind', () => {
						rpc.call('stale', null);
					});
					await controller.wait();
					return [{ config: controller.config, stale: controller.stale }, []];
				},
				route: async (url) => {
					if (!controller) throw new Error('Controller is not initialised');
					return [await controller.route(url), []];
				},
				unroute: async (url) => {
					if (!controller) throw new Error('Controller is not initialised');
					return [await controller.unroute(url), []];
				},
				viewport: async ([width, height]) => {
					controller?.reportViewport(Number(width), Number(height));
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
				frameInfo: async (index) => {
					const win = historyWindow(index);
					if (!win)
						return [
							{ url: null, title: null, canGoBack: null, canGoForward: null },
							[],
						];
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
				cookies: async (command) => {
					if (!controller) throw new Error('Controller is not initialised');
					return [await controller.cookieCommand(command), []];
				},
				goneClients: async (clients) => {
					if (!controller) throw new Error('Controller is not initialised');
					return [await controller.goneClients(clients), []];
				},
				frameActivated: async ({ index, token, nested }) => {
					noteActivation(historyWindow(index), String(token), nested === true);
					return [null, []];
				},
				frameCommand: async ({ index, command }) => {
					const win = historyWindow(index);
					if (!win) return [false, []];
					if (command === 'typed') {
						noteBrowserNavigation(win);
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
			(data) => window.parent.postMessage(data, hostOrigin),
		);

		window.addEventListener('message', (event) => {
			if (event.origin !== hostOrigin || event.source !== window.parent) return;
			rpc.receive(event.data);
		});

		rpc.call('ready', undefined);
	}
}
