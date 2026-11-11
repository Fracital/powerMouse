// The built-in blocker in the service worker (docs/adblock.md): the engine
// of rust/block (Brave's adblock crate) instantiated from the module the
// controller handed this thread with the other wasm modules
// (src/wasm/thread.ts), fed the lists the host named, and asked before every
// request goes to the transport. The lists are fetched through the transport
// (the user's own address never reaches the list servers), compiled once and
// kept serialized in CacheStorage under a key of the list URLs and the
// engine's format, so a restarted worker loads in milliseconds (measured:
// 9 ms for the 198,000-line Brave list, against 245 ms to compile it) and
// the lists are fetched again only when the stored engine is older than the
// refresh interval. A fetch that fails leaves the stored engine serving;
// with nothing stored, the blocker is off until a fetch succeeds.
//
// The crate never discards a compiled regex on wasm (it has no clock), so a
// long-lived worker's instance only grows: past a ceiling it is replaced by
// a fresh one loading the same serialized engine.
import { carriedCsp } from '../blocker/csp';
import {
	BlockerInstance,
	FLAG_HOSTS,
	FLAG_TRUSTED,
	OP,
} from '../blocker/instance';
import {
	requestTypeOf,
	type AdblockInit,
	type AdblockList,
	type AdblockPage,
} from '../blocker/types';
import type Router from './Router';

/** the CacheStorage store the serialized engines and the resources live in */
const STORE = 'stomp-adblock';
/** the engine's serialized format: the crate's version, which must match to load (Engine::deserialize) */
const FORMAT = 'adblock-rust-0.13.5-dat8';
const STORED_AT = 'x-stomp-stored-at';
/** linear memory past which the instance is replaced */
const MEMORY_LIMIT = 160 * 1024 * 1024;
/**
 * how long a navigation waits for an engine that is being built for the
 * first time (the lists are being fetched): past it the document loads
 * unfiltered rather than not at all, and the engine serves once it is built
 */
const FIRST_BUILD_WAIT_MS = 5_000;
/** scriptlet rewrites kept, by their lines (a site's pages share theirs) */
const SCRIPT_MEMO = 64;

export interface Verdict {
	block: boolean;
	/** a `data:` URL to answer with instead ($redirect) */
	redirect?: string;
	/** the URL to fetch instead ($removeparam) */
	url?: string;
}

/** a request as the service worker is about to send it, by its real URLs */
export interface BlockerRequest {
	/** the real URL */
	url: string;
	/** the real URL of the document or worker that makes it (a nested document's parent), or '' when nobody knows */
	source: string;
	/** the fetch event's destination (the load an inject's copy stands for) */
	destination: string;
	navigation: boolean;
	topLevel: boolean;
	method: string;
	/** a beacon or an `<a ping>` */
	ping?: boolean;
}

/** what the lists say of a request: at most one of the three */
export interface Decision {
	/** blocked: a network error to the page */
	block?: true;
	/** `$redirect`: answered with this resource instead of the network */
	resource?: { body: Uint8Array<ArrayBuffer>; type: string };
	/** `$removeparam`: fetched at this URL instead */
	url?: string;
}

/** the bytes and type of a `data:` URL as the crate writes a redirect resource (`data:<mime>;base64,<body>`) */
function dataResource(
	url: string,
): { body: Uint8Array<ArrayBuffer>; type: string } | null {
	const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url);
	if (!match) return null;
	try {
		const text = /;base64$/i.test(match[2])
			? atob(match[3])
			: decodeURIComponent(match[3]);
		return {
			body: Uint8Array.from(text, (char) => char.charCodeAt(0)),
			type: match[1] || 'text/plain',
		};
	} catch (error) {
		return null;
	}
}

/** what the crate answers for a document's cosmetic resources */
interface CosmeticResources {
	hide_selectors: string[];
	procedural_actions: string[];
	exceptions: string[];
	injected_script: string;
	generichide: boolean;
}

/** a fetch through the transport (the lists come from their servers as the page's requests do) */
type FetchResource = (url: string) => Promise<Response>;

async function keyOf(init: AdblockInit): Promise<string> {
	const text = JSON.stringify([
		FORMAT,
		init.lists.map((list) => [list.url, !!list.trusted, list.format ?? '']),
		init.engine ?? '',
	]);
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
}

export class Blocker {
	readonly #init: AdblockInit;
	readonly #fetch: FetchResource;
	readonly #given: () => Promise<WebAssembly.Module | null>;
	#module: WebAssembly.Module | null = null;
	#instance: BlockerInstance | null = null;
	/** the engine is loaded and answers */
	#ready = false;
	/** the first load or build, whichever settles first; false when nothing could be loaded */
	readonly #settled: Promise<boolean>;
	#key = '';
	#resources = '';
	#building: Promise<void> | null = null;
	#replacing: Promise<void> | null = null;
	readonly #scripts = new Map<string, string>();
	/** a host-visible note of what went wrong, for the request log */
	lastError: string | null = null;

	/** `module` settles with the thread's compiled blocker module, or null when it has none */
	constructor(
		init: AdblockInit,
		fetch: FetchResource,
		module: () => Promise<WebAssembly.Module | null>,
	) {
		this.#init = init;
		this.#fetch = fetch;
		this.#given = module;
		this.#settled = this.#start();
		this.#settled.then((ready) => {
			this.#failed = !ready;
		});
	}
	get ready(): boolean {
		return this.#ready;
	}
	#failed = false;
	/** the start is over and no engine answers: the next controller to ask gets a new blocker, which tries again */
	get failed(): boolean {
		return this.#failed && !this.#ready && !this.#building;
	}
	/** the engine answers, or nothing could be loaded; bounded by `ms` for a page that must not wait on a first fetch of the lists */
	settled(ms = FIRST_BUILD_WAIT_MS): Promise<boolean> {
		if (this.#ready) return Promise.resolve(true);
		return Promise.race([
			this.#settled,
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
		]);
	}

	async #start(): Promise<boolean> {
		try {
			this.#module = await this.#given();
		} catch (error) {
			this.#module = null;
		}
		if (!this.#module) {
			this.lastError = 'the blocker module did not reach the service worker';
			return false;
		}
		try {
			this.#key = await keyOf(this.#init);
		} catch (error) {
			// no crypto.subtle (an insecure context): the engine is built every start
			this.#key = '';
		}
		const stored = this.#key ? await this.#stored() : null;
		if (stored) {
			const loaded = this.#load(stored.engine, stored.resources);
			const stale = Date.now() - stored.at > this.#init.refreshMs;
			if (loaded && !stale) return true;
			if (loaded) {
				// serve the stored engine while a fresh one is fetched
				this.#refresh();
				return true;
			}
		}
		await this.#refresh();
		return this.#ready;
	}

	/** the stored engine and resources under this key, when both are there */
	async #stored(): Promise<{
		engine: Uint8Array<ArrayBuffer>;
		resources: string;
		at: number;
	} | null> {
		try {
			const cache = await caches.open(STORE);
			const engine = await cache.match(this.#url('engine'));
			const resources = await cache.match(this.#url('resources'));
			if (!engine || !resources) return null;
			return {
				engine: new Uint8Array(await engine.arrayBuffer()),
				resources: await resources.text(),
				at: Number(engine.headers.get(STORED_AT)) || 0,
			};
		} catch (error) {
			return null;
		}
	}
	#url(part: string): string {
		return `https://adblock.stomp.invalid/${this.#key}/${part}`;
	}
	async #store(
		engine: Uint8Array<ArrayBuffer>,
		resources: string,
	): Promise<void> {
		if (!this.#key) return;
		try {
			const cache = await caches.open(STORE);
			// everything under other keys is an engine of other lists or an
			// older format: dropped, so the store holds one engine
			for (const request of await cache.keys())
				if (
					!request.url.startsWith(`https://adblock.stomp.invalid/${this.#key}/`)
				)
					await cache.delete(request);
			const headers = { [STORED_AT]: String(Date.now()) };
			await cache.put(this.#url('engine'), new Response(engine, { headers }));
			await cache.put(
				this.#url('resources'),
				new Response(resources, { headers }),
			);
		} catch (error) {
			// no storage: the engine is built again next start
		}
	}

	/** a fresh instance holding `engine` and `resources`; false when the bytes are not an engine of this format */
	#load(engine: Uint8Array<ArrayBuffer>, resources: string): boolean {
		let instance: BlockerInstance;
		try {
			instance = new BlockerInstance(this.#module!);
			if (instance.call(resources, OP.resources) !== 0) return false;
			if (instance.call(engine, OP.load) !== 0) return false;
		} catch (error) {
			this.lastError = `the engine could not be loaded: ${String(error)}`;
			return false;
		}
		this.#instance = instance;
		this.#resources = resources;
		this.#ready = true;
		return true;
	}

	/** fetch the lists and the resources, build, store and swap in the engine */
	#refresh(): Promise<void> {
		if (!this.#building)
			this.#building = this.#build().finally(() => {
				this.#building = null;
			});
		return this.#building;
	}
	async #build(): Promise<void> {
		let resources: string;
		try {
			resources = await this.#fetchText(this.#init.resources);
			JSON.parse(resources);
		} catch (error) {
			this.lastError = `the resources could not be fetched: ${String(error)}`;
			return;
		}
		let engine: Uint8Array<ArrayBuffer>;
		if (this.#init.engine) {
			try {
				engine = new Uint8Array(
					await (await this.#fetchOk(this.#init.engine)).arrayBuffer(),
				);
			} catch (error) {
				this.lastError = `the prebuilt engine could not be fetched: ${String(error)}`;
				return;
			}
		} else {
			const lists = await Promise.all(
				this.#init.lists.map(async (list) => {
					try {
						return { list, text: await this.#fetchText(list.url) };
					} catch (error) {
						console.warn(`Stomp: filter list not fetched: ${String(error)}`);
						return null;
					}
				}),
			);
			const fetched = lists.filter(
				(entry): entry is { list: AdblockList; text: string } => entry !== null,
			);
			if (!fetched.length) {
				this.lastError = 'no filter list could be fetched';
				return;
			}
			let builder: BlockerInstance;
			try {
				builder = new BlockerInstance(this.#module!);
				for (const { list, text } of fetched)
					builder.call(
						text,
						OP.addList |
							(list.trusted ? FLAG_TRUSTED : 0) |
							(list.format === 'hosts' ? FLAG_HOSTS : 0),
					);
				if (builder.call('', OP.build) !== 0) {
					this.lastError = 'the lists could not be compiled';
					return;
				}
				engine = builder.bytes();
			} catch (error) {
				this.lastError = `the lists could not be compiled: ${String(error)}`;
				return;
			}
		}
		// the engine is loaded into an instance of its own (the builder holds
		// the lists' text and the build's garbage), stored, and serves
		if (this.#load(engine, resources)) {
			this.#scripts.clear();
			await this.#store(engine, resources);
		}
	}
	async #fetchOk(url: string): Promise<Response> {
		const response = await this.#fetch(url);
		if (!response.ok) throw new Error(`status ${response.status} for ${url}`);
		return response;
	}
	async #fetchText(url: string): Promise<string> {
		return (await this.#fetchOk(url)).text();
	}

	/** the instance to ask, replaced when it has grown past the ceiling */
	#engine(): BlockerInstance | null {
		const instance = this.#instance;
		if (!instance) return null;
		if (instance.memoryBytes > MEMORY_LIMIT && !this.#replacing)
			this.#replacing = this.#replace().finally(() => {
				this.#replacing = null;
			});
		return instance;
	}
	async #replace(): Promise<void> {
		const stored = await this.#stored();
		if (stored) this.#load(stored.engine, stored.resources);
	}
	#call(input: string, op: number): string | null {
		const instance = this.#engine();
		if (!instance) return null;
		try {
			if (instance.call(input, op) !== 0) return null;
			return instance.text();
		} catch (error) {
			// a trap: the instance is dead, a fresh one loads the stored engine
			this.#instance = null;
			this.#ready = false;
			if (!this.#replacing)
				this.#replacing = this.#replace().finally(() => {
					this.#replacing = null;
				});
			return null;
		}
	}

	/** the lists' verdict on a request, or null while no engine answers */
	check(
		url: string,
		source: string,
		type: string,
		method: string,
	): Verdict | null {
		const answer = this.#call(
			`${url}\t${source}\t${type}\t${method.toLowerCase()}`,
			OP.check,
		);
		if (answer === null) return null;
		try {
			const parsed = JSON.parse(answer) as {
				block?: boolean;
				redirect?: string;
				url?: string;
			};
			return { block: !!parsed.block, ...parsed };
		} catch (error) {
			return null;
		}
	}
	/** the `$csp=` directives for a document or subdocument, joined, or null */
	csp(url: string, source: string, type: string): string | null {
		const answer = this.#call(`${url}\t${source}\t${type}\tget`, OP.csp);
		return answer || null;
	}
	/**
	 * the cosmetic side of the lists for a document at `url`: what the inject
	 * applies, with the scriptlets rewritten by `rewrite` (a page's script)
	 */
	cosmetic(
		url: string,
		rewrite: (script: string) => string,
	): AdblockPage | null {
		const answer = this.#call(url, OP.cosmetic);
		if (answer === null) return null;
		let resources: CosmeticResources;
		try {
			resources = JSON.parse(answer) as CosmeticResources;
		} catch (error) {
			return null;
		}
		let script = '';
		if (resources.injected_script) {
			// the crate writes a page's scriptlets in the order of a hash set
			// that changes from call to call: the same lines in any order are
			// the same scriptlets, and one rewrite serves them all
			const key = resources.injected_script.split('\n').sort().join('\n');
			const memo = this.#scripts.get(key);
			if (memo !== undefined) script = memo;
			else {
				try {
					script = rewrite(resources.injected_script);
				} catch (error) {
					console.warn('Stomp: the scriptlets could not be rewritten', error);
					script = '';
				}
				if (this.#scripts.size >= SCRIPT_MEMO)
					this.#scripts.delete(this.#scripts.keys().next().value!);
				this.#scripts.set(key, script);
			}
		}
		return {
			hide: resources.hide_selectors,
			procedural: resources.procedural_actions,
			exceptions: resources.exceptions,
			script,
			generichide: resources.generichide,
		};
	}
	/** the generic hide selectors among `classes` and `ids` a page saw, minus its `exceptions` */
	classIds(classes: string[], ids: string[], exceptions: string[]): string[] {
		const answer = this.#call(
			JSON.stringify({ classes, ids, exceptions }),
			OP.classIds,
		);
		if (answer === null) return [];
		try {
			return JSON.parse(answer) as string[];
		} catch (error) {
			return [];
		}
	}
	/**
	 * What the lists say of a request, or null for "send it": the request's
	 * type as a content blocker in the browser would name it, and its party
	 * from the real document that makes it
	 */
	decide(request: BlockerRequest): Decision | null {
		const type = request.ping
			? 'ping'
			: requestTypeOf(
					request.destination,
					request.navigation,
					request.topLevel,
				);
		const verdict = this.check(
			request.url,
			// a top-level document is its own first party
			request.navigation && request.topLevel ? request.url : request.source,
			type,
			request.method,
		);
		if (!verdict) return null;
		if (verdict.redirect) {
			const resource = dataResource(verdict.redirect);
			if (resource) return { resource };
		}
		if (verdict.block) return { block: true };
		if (verdict.url && verdict.url !== request.url) return { url: verdict.url };
		return null;
	}
	/**
	 * The `$csp=` policies of the lists for a document at `url` (a nested
	 * one's `top` is the page it is framed under), reduced to what the proxy
	 * can enforce (src/blocker/csp.ts), or null
	 */
	documentCsp(url: string, top: string | null): string | null {
		const directives = this.csp(
			url,
			top ?? url,
			top === null ? 'document' : 'subdocument',
		);
		return directives ? carriedCsp(directives) : null;
	}
	/** the resources JSON the engine holds (tests) */
	get resourcesText(): string {
		return this.#resources;
	}
}

/**
 * The route a document's inject asks for the generic hide rules of the
 * classes and ids it has seen (docs/adblock.md): `{classes, ids,
 * exceptions}` in, the selectors to hide out. Under the controller's
 * address, like `whoami`: no page URL corresponds to it.
 */
export function registerBlocker(router: Router, blocker: Blocker) {
	router.routes.set(/^\/adblock$/, async (request) => {
		let selectors: string[] = [];
		try {
			const asked = (await request.json()) as {
				classes?: unknown;
				ids?: unknown;
				exceptions?: unknown;
			};
			const strings = (value: unknown): string[] =>
				Array.isArray(value)
					? value.filter((entry): entry is string => typeof entry === 'string')
					: [];
			selectors = blocker.classIds(
				strings(asked.classes),
				strings(asked.ids),
				strings(asked.exceptions),
			);
		} catch (error) {
			// not a question: no rules
		}
		return new Response(JSON.stringify(selectors), {
			headers: {
				'content-type': 'application/json',
				'cache-control': 'no-store',
			},
		});
	});
}
