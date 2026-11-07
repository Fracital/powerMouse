// Runs inside dist/controllerFrame.html on the proxy origin. Owns the
// service worker registration, the transport and a StompController; the
// host application (a different origin) drives it over postMessage through
// RemoteController. Proxied frames are same-origin siblings of this frame, so
// it can read their location and drive their history on the host's behalf.
import type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
import { CLIENT_KEY } from '../rewriteJS';
import { RpcHelper } from '../transport/rpc';
import { canTraverse, traverse } from './history';
import { StompController } from './index';
import {
	ControllerFrameInit,
	FrameBound,
	HostBound,
	REMOTE_RPC,
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

		async function loadTransport(
			descriptor: TransportDescriptor,
		): Promise<ProxyTransport> {
			const url = new URL(descriptor.module, location.href);
			if (url.origin !== location.origin)
				throw new Error('Transport modules must live on the proxy origin');
			const { default: Transport } = await import(/* @vite-ignore */ url.href);
			return new Transport(...(descriptor.options || []));
		}

		/**
		 * A proxied frame is a same-origin sibling of this frame. The host
		 * addresses it by index into its `frames` list (indexed access on a
		 * cross-origin parent is allowed; named access is not).
		 */
		function proxiedWindow(index: number): (Window & typeof globalThis) | null {
			if (!Number.isInteger(index) || index < 0) return null;
			try {
				const win = window.parent[index] as
					(Window & typeof globalThis) | undefined;
				if (!win || win === window) return null;
				// same-origin with us, and one of ours (it has the client), or
				// still blank before its first navigation
				if (
					CLIENT_KEY in (win as object) ||
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
					const registration = await navigator.serviceWorker.register(
						`${init.directory}serviceWorker.js`,
						{ scope: init.directory, updateViaCache: 'none' },
					);
					const serviceworker = await activated(registration);
					const transport = await loadTransport(init.transport);
					controller = new StompController({
						serviceworker,
						transport,
						directory: init.directory,
						codec: init.codec,
						frameAncestors: [hostOrigin],
						openTab: !!init.openTab,
						cache: !!init.cache,
					});
					await controller.wait();
					return [{ config: controller.config }, []];
				},
				route: async (url) => {
					if (!controller) throw new Error('Controller is not initialised');
					return [await controller.route(url), []];
				},
				setTransport: async (descriptor) => {
					if (!controller) throw new Error('Controller is not initialised');
					controller.setTransport(await loadTransport(descriptor));
				},
				frameInfo: async (index) => {
					const win = proxiedWindow(index);
					if (!win)
						return [
							{ url: null, title: null, canGoBack: null, canGoForward: null },
							[],
						];
					const client = (
						win as unknown as Record<string, { url?: { toString(): string } }>
					)[CLIENT_KEY];
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
				cookies: async (command) => {
					if (!controller) throw new Error('Controller is not initialised');
					return [await controller.cookieCommand(command), []];
				},
				frameCommand: async ({ index, command }) => {
					const win = proxiedWindow(index);
					if (!win) return [false, []];
					if (command === 'reload') {
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
