// The slots of the site pool (docs/site-pool.md, "Thin slots";
// docs/extensions.md, "Content scripts on the slots"): a slot's service
// worker keeps no extensions. The packages, their state and the documents'
// tokens are the hub's worker's, on the host origin, so a document a slot
// serves asks that worker for its content scripts over a MessagePort the
// hub's page hands both workers, as the blocker's questions go
// (./remoteBlocker.ts): its shell's part (matched there on the document's
// real URL, its frame and the extensions' site access), each entry's
// script and an isolated world's modules, and its contexts' `extapi`
// calls. The answers are the hub's own; the slot only carries them. The
// extensions' messages cross on another way, the slot's agent relaying the
// extensions' channels of its origin to the hub's page
// (src/controller/site.ts relayExtensionBuses).
import {
	shellOf,
	type ExtensionShell,
	type ShellDocument,
	type ShellParts,
} from './extensions/contentScripts';

type ExtensionsOp = 'shell' | 'script' | 'api';

/** slot worker -> hub worker */
export interface ExtensionsCall {
	call: number;
	op: ExtensionsOp;
	args: unknown[];
}
/** hub worker -> slot worker: an answer (`call`), or what is installed now */
export interface ExtensionsReply {
	call?: number;
	result?: unknown;
	/** whether any extension is installed (no document needs to ask while none is) */
	any: boolean;
}

/** a response of the hub's extension routes, as it crosses */
export interface ServedResponse {
	status: number;
	type: string;
	cache: string | null;
	body: string;
}

/** what the hub's worker answers a slot's with (rewrites.ts registerRewrites) */
export interface ExtensionsServe {
	any(): boolean;
	ready(): Promise<void>;
	onChange(listener: () => void): () => void;
	/** the shell part of a slot's document, with the slot's own runtime URL and access name */
	shell(
		doc: ShellDocument,
		runtime: string,
		access: string,
	): Promise<ShellParts | null>;
	/** a content script's route (`<directory>extcs/...`), for a document of `origin` */
	script(url: string, origin: string | null): Promise<ServedResponse>;
	/** a context's `extapi` call from the slot's client `client` */
	api(body: string, client: string): Promise<ServedResponse>;
}

/** how long a document's shell waits for the hub's worker (it holds the document's first byte) */
const SHELL_MS = 2000;
/** a script or a call (a large entry is rewritten there on its first load) */
const LOAD_MS = 30000;

/**
 * the hub worker's end: answer a slot's worker on `port`, from the server
 * `serve()` gives (the controller's, once it is built: a slot asked while
 * it builds is answered then, never told there are no extensions)
 */
export function serveExtensions(
	port: MessagePort,
	serve: () => Promise<ExtensionsServe | undefined>,
) {
	let unwatch: (() => void) | undefined;
	let closed = false;
	const ready = serve().then(
		async (served) => {
			await served?.ready().catch(() => {});
			return served;
		},
		() => undefined,
	);
	port.addEventListener('message', async (event) => {
		const call = event.data as ExtensionsCall | null;
		if (
			typeof call !== 'object' ||
			call === null ||
			typeof call.call !== 'number' ||
			!Array.isArray(call.args)
		)
			return;
		const served = await ready;
		let result: unknown = null;
		try {
			if (served) result = await answer(served, call);
		} catch (error) {
			console.warn('Stomp: a slot asked the extensions in vain', error);
			result = null;
		}
		port.postMessage({
			call: call.call,
			result,
			any: !!served?.any(),
		} satisfies ExtensionsReply);
	});
	port.addEventListener('close', () => {
		closed = true;
		unwatch?.();
	});
	port.start();
	void ready.then((served) => {
		const tell = () =>
			port.postMessage({ any: !!served?.any() } satisfies ExtensionsReply);
		if (served && !closed) unwatch = served.onChange(tell);
		tell();
	});
}

function answer(served: ExtensionsServe, { op, args }: ExtensionsCall) {
	switch (op) {
		case 'shell':
			return served.shell(
				args[0] as ShellDocument,
				String(args[1] ?? ''),
				String(args[2] ?? ''),
			);
		case 'script':
			return served.script(
				String(args[0] ?? ''),
				typeof args[1] === 'string' ? args[1] : null,
			);
		case 'api':
			return served.api(String(args[0] ?? ''), String(args[1] ?? ''));
		default:
			return null;
	}
}

interface Pending {
	call: ExtensionsCall;
	resolve: (value: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
}

const unavailable = (what: string): Response =>
	new Response(
		what === 'api'
			? JSON.stringify({ error: 'The extensions did not answer.' })
			: '/* the extensions did not answer */',
		{
			status: 503,
			headers: {
				'content-type': what === 'api' ? 'application/json' : 'text/javascript',
				'cache-control': 'no-store',
			},
		},
	);

const responseOf = (served: ServedResponse): Response =>
	new Response(served.body, {
		status: served.status,
		headers: {
			'content-type': served.type,
			...(served.cache ? { 'cache-control': served.cache } : {}),
		},
	});

/**
 * A slot's worker's extensions: the hub's worker's, asked on the newest
 * port its controller handed it. `renew` asks the controller for another
 * when the port closed or an answer did not come (the hub's worker was
 * stopped and started again, which closes every port it held).
 */
export class RemoteExtensions {
	#port: MessagePort | null = null;
	#next = 0;
	#pending = new Map<number, Pending>();
	/** whether the hub's worker has an extension; undefined until it said */
	#any: boolean | undefined;
	#renewing = false;
	renew?: () => Promise<MessagePort | null>;
	/** whether a document must ask: the hub has extensions, or has not said yet */
	get any(): boolean {
		return this.#any !== false;
	}
	bind(port: MessagePort) {
		this.#port?.close();
		this.#port = port;
		port.addEventListener('message', (event) => {
			const reply = event.data as ExtensionsReply | null;
			if (typeof reply !== 'object' || reply === null) return;
			this.#any = reply.any === true;
			if (typeof reply.call !== 'number') return;
			const pending = this.#pending.get(reply.call);
			if (!pending) return;
			this.#pending.delete(reply.call);
			clearTimeout(pending.timer);
			pending.resolve(reply.result);
		});
		port.addEventListener('close', () => {
			if (this.#port === port) this.#lost();
		});
		port.start();
		for (const { call } of this.#pending.values()) port.postMessage(call);
	}
	#lost() {
		if (this.#renewing || !this.renew) return;
		this.#renewing = true;
		this.renew()
			.then((port) => {
				if (port) this.bind(port);
			})
			.catch(() => {})
			.finally(() => (this.#renewing = false));
	}
	#ask(op: ExtensionsOp, args: unknown[], ms: number): Promise<unknown> {
		return new Promise((resolve) => {
			const call: ExtensionsCall = { call: this.#next++, op, args };
			const timer = setTimeout(() => {
				if (!this.#pending.delete(call.call)) return;
				resolve(null);
				this.#lost();
			}, ms);
			this.#pending.set(call.call, { call, resolve, timer });
			this.#port?.postMessage(call);
		});
	}
	/** the shell part of a document this slot serves: null when no extension reaches it */
	async shell(
		doc: ShellDocument,
		runtime: string,
		access: string,
	): Promise<ExtensionShell | null> {
		if (!this.any) return null;
		const parts = (await this.#ask(
			'shell',
			[doc, runtime, access],
			SHELL_MS,
		)) as ShellParts | null;
		if (
			!parts ||
			typeof parts.json !== 'string' ||
			!Array.isArray(parts.routes)
		)
			return null;
		return shellOf({
			runtime,
			json: parts.json,
			routes: parts.routes.map(String),
		});
	}
	/** a content script's route, for a document of `origin` (null: none known) */
	async script(request: Request, origin: string | null): Promise<Response> {
		const served = (await this.#ask(
			'script',
			[request.url, origin],
			LOAD_MS,
		)) as ServedResponse | null;
		return served ? responseOf(served) : unavailable('script');
	}
	/** a context's `extapi` call, from the slot's client `client` */
	async api(request: Request, client: string | undefined): Promise<Response> {
		if (request.method !== 'POST')
			return new Response(JSON.stringify({ error: 'POST only' }), {
				status: 405,
				headers: { 'content-type': 'application/json' },
			});
		const served = (await this.#ask(
			'api',
			[await request.text(), client ?? ''],
			LOAD_MS,
		)) as ServedResponse | null;
		return served ? responseOf(served) : unavailable('api');
	}
}
