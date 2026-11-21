// The documents a Document-Isolation-Policy of the proxy's own isolates
// (src/isolation.ts servedIsolationPolicy): under a host whose page is not
// cross-origin isolated, a proxied page that is isolated natively, and every
// document in its frames, is served with that policy, which puts it in an
// agent cluster of its own (Chrome 137 and later). The controller's realm
// is not in it: the frame's window answers it as one of another origin
// does (postMessage, location.replace, its frames), its document, its
// client, its history and its navigation are out of reach.
//
// What the controller did there synchronously, it asks of an agent: a
// hidden document of the proxy's origin, served with the same policy, which
// is in that cluster (two documents of one origin that the policy isolates
// reach each other, whatever their values, and frames of one page do:
// measured in Chrome 157) and reaches the frames through the windows of the
// host's page (`frames`, indexed, which every origin reads). It runs the
// controller frame's script (dist/controllerFrame.js), whose bundle carries
// this module, and answers over a MessagePort: the frame's address, title
// and history (./history.ts), its Back, Forward and Reload, the user
// activations and the host's input the history marks, and it keeps on its
// window what the proxied documents read synchronously from the
// controller's: the host's geometry (./geometry.ts) and the compiled core
// module (publishCore). It is made the first time a frame shows such a
// document, and its route takes only a token the controller gave the
// service worker over its own channel, once.
import type { HostGeometry } from '../config';
import { APART_ROUTE } from '../isolation';
import { RpcHelper } from '../transport/rpc';
import { coreModuleKey } from '../version';
import { shareGeometry } from './geometry';
import {
	bindHistory,
	canTraverse,
	clientView,
	earlierWindows,
	noteActivation,
	noteBrowserNavigation,
	reloadWindow,
	stopWindow,
	traverse,
} from './history';
import { markHostInput } from './hostActivation';

export { APART_ROUTE };
const APART_RPC = '$stomp$apart';
const APART_INIT = '$stomp$apartInit';
/** how long the agent may take to load, and an answer to come */
const APART_WAIT_MS = 10_000;

/** what the controller tells its agent when it starts it */
export interface ApartInit {
	/** the client's name on a proxied window (helperNames) */
	client: string;
	/** how many windows up from the agent the frames' parent is: 1 under the controller's page, 2 under a RemoteController's controller frame */
	up: number;
}

/** what the agent says of a frame (as RemoteController's frameInfo) */
export interface ApartFrameInfo {
	url: string | null;
	title: string | null;
	canGoBack: boolean | null;
	canGoForward: boolean | null;
}

export type ApartCommand =
	'back' | 'forward' | 'reload' | 'hardReload' | 'stop' | 'typed';

type AgentBound = {
	info: [number[], ApartFrameInfo | null];
	command: [{ path: number[]; command: ApartCommand }, boolean | null];
	activated: [{ path: number[]; token: string; nested: boolean }];
	geometry: [HostGeometry];
	hostInput: [number];
	core: [ArrayBuffer];
};
type ControllerBound = Record<never, never>;

/**
 * Leave the compiled core module on this window (coreModuleKey), where a
 * proxied top of this agent cluster takes it synchronously when its client
 * is made (src/inject/dom/Client.ts #controllerModule): a top's first task
 * often rewrites (an inline script's eval, a `javascript:` link its markup
 * has) before the module it asked for (PAGE_MODULES) can arrive, and such
 * a top fetched the bytes with a synchronous request and compiled them on
 * its main thread, 10 to 12 ms on real sites. Left once, before the first
 * handshake, so no proxied page exists yet that could have put another
 * there, and for good: nothing replaces it.
 */
export function publishCore(
	client: string | undefined,
	module: WebAssembly.Module,
): void {
	if (!client) return;
	try {
		Reflect.defineProperty(globalThis, coreModuleKey(client), {
			value: module,
			enumerable: false,
			configurable: false,
			writable: false,
		});
	} catch (error) {
		// a window that keeps nothing: its documents compile their own
	}
}

/**
 * Whether `win`, a frame's window, shows a document out of this realm's
 * reach: of another origin, or (a frame of the proxy's origin) in the
 * cluster a Document-Isolation-Policy isolates
 */
export function outOfReach(win: Window | null | undefined): boolean {
	if (!win) return false;
	try {
		void (win as unknown as { document: unknown }).document;
		return false;
	} catch (error) {
		return true;
	}
}

/** the controller's side: an agent it started, and what it asks of it */
export class ApartAgent {
	private constructor(
		private rpc: RpcHelper<ControllerBound, AgentBound>,
		readonly element: HTMLIFrameElement,
	) {}
	/**
	 * Start the agent at `src` (the route with the token the service worker
	 * was given) in a hidden frame of this document; null when it did not
	 * start in time
	 */
	static start(src: URL, init: ApartInit): Promise<ApartAgent | null> {
		return new Promise((resolve) => {
			const element = document.createElement('iframe');
			element.hidden = true;
			element.style.display = 'none';
			element.setAttribute('aria-hidden', 'true');
			element.tabIndex = -1;
			const timer = setTimeout(() => {
				element.remove();
				resolve(null);
			}, APART_WAIT_MS);
			element.addEventListener(
				'load',
				() => {
					const win = element.contentWindow;
					if (!win) return;
					const channel = new MessageChannel();
					const rpc = new RpcHelper<ControllerBound, AgentBound>(
						{},
						APART_RPC,
						(data, transfer) => channel.port1.postMessage(data, transfer),
					);
					channel.port1.onmessage = (event) => {
						if (
							typeof event.data === 'object' &&
							event.data !== null &&
							APART_INIT in event.data
						) {
							clearTimeout(timer);
							resolve(new ApartAgent(rpc, element));
							return;
						}
						rpc.receive(event.data);
					};
					// (the agent's document is of this realm's origin)
					win.postMessage({ [APART_INIT]: init }, location.origin, [
						channel.port2,
					]);
				},
				{ once: true },
			);
			element.src = src.href;
			(document.body ?? document.documentElement).append(element);
		});
	}
	/** an answer of the agent's, null when none came in time */
	#ask<Method extends keyof AgentBound>(
		method: Method,
		args: AgentBound[Method][0],
	): Promise<AgentBound[Method][1] | null> {
		return Promise.race([
			this.rpc.call(method, args).catch(() => null),
			new Promise<null>((resolve) =>
				setTimeout(() => resolve(null), APART_WAIT_MS),
			),
		]) as Promise<AgentBound[Method][1] | null>;
	}
	info(path: number[]) {
		return this.#ask('info', path);
	}
	command(path: number[], command: ApartCommand) {
		return this.#ask('command', { path, command });
	}
	activated(path: number[], token: string, nested: boolean) {
		void this.#ask('activated', { path, token, nested });
	}
	geometry(geometry: HostGeometry) {
		void this.#ask('geometry', geometry);
	}
	hostInput(now: number) {
		void this.#ask('hostInput', now);
	}
	core(bytes: ArrayBuffer) {
		void this.#ask('core', bytes);
	}
}

/** whether this document is the agent (its route, in a frame) */
export function isApartAgent(): boolean {
	return (
		typeof window !== 'undefined' &&
		window.parent !== window &&
		new RegExp(`/${APART_ROUTE}/[\\w-]+$`).test(location.pathname)
	);
}

/** the agent's side: wait for the controller that made this frame, and answer it */
export function runApartAgent() {
	const listen = (event: MessageEvent) => {
		const init = (event.data as Record<string, unknown> | null)?.[
			APART_INIT
		] as ApartInit | undefined;
		if (
			event.source !== window.parent ||
			event.origin !== location.origin ||
			typeof init?.client !== 'string' ||
			!event.ports[0]
		)
			return;
		removeEventListener('message', listen);
		serve(init, event.ports[0]);
	};
	addEventListener('message', listen);
}

function serve(init: ApartInit, port: MessagePort) {
	const name = init.client;
	const up = Math.max(1, Math.min(2, Number(init.up) || 1));
	/** the window whose frames the host's frames are */
	const base = (): Window => {
		let win: Window = window;
		for (let i = 0; i < up; i++) win = win.parent;
		return win;
	};
	/** a proxied frame's window by its path from there, its history told how to read its documents; null when it is out of reach here too */
	const frameAt = (path: number[]): Window | null => {
		if (!Array.isArray(path) || !path.length) return null;
		let win: Window | undefined = base();
		for (const index of path) {
			if (!Number.isInteger(index) || index < 0) return null;
			win = (win as unknown as Record<number, Window | undefined>)[index];
			if (!win || win === window) return null;
		}
		try {
			if (!(name in (win as object))) return null;
		} catch (error) {
			return null; // not of this cluster
		}
		bindHistory(
			win,
			(target) => clientView(target, name),
			earlierWindows(win, name),
		);
		return win;
	};
	const rpc = new RpcHelper<AgentBound, ControllerBound>(
		{
			info: async (path) => {
				const win = frameAt(path);
				if (!win) return [null, []];
				const client = (
					win as unknown as Record<string, { url?: { toString(): string } }>
				)[name];
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
			command: async ({ path, command }) => {
				const win = frameAt(path);
				if (!win) return [null, []];
				if (command === 'typed') {
					noteBrowserNavigation(win);
					return [true, []];
				}
				if (command === 'reload' || command === 'hardReload') {
					await reloadWindow(win, command === 'hardReload');
					return [true, []];
				}
				if (command === 'stop') return [stopWindow(win), []];
				return [await traverse(win, command), []];
			},
			activated: async ({ path, token, nested }) => {
				noteActivation(frameAt(path), String(token), nested === true);
			},
			geometry: async (geometry) => {
				shareGeometry(window, geometry);
			},
			hostInput: async (now) => {
				markHostInput(base(), name, Number(now));
			},
			core: async (bytes) => {
				// once: a module left there is the one every document takes
				if (Reflect.getOwnPropertyDescriptor(window, coreModuleKey(name)))
					return;
				try {
					publishCore(name, await WebAssembly.compile(bytes));
				} catch (error) {
					// its documents compile their own
				}
			},
		},
		APART_RPC,
		(data, transfer) => port.postMessage(data, transfer),
	);
	port.onmessage = (event) => rpc.receive(event.data);
	port.postMessage({ [APART_INIT]: true });
}
