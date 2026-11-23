// Content scripts from the worker (docs/extensions.md "Content scripts"):
// the worker serves the document, so it matches the extensions' entries on
// the document's real URL and writes what runs into the document's shell,
// ahead of the inject bundle: the runtime asset, the payload, and one
// `<script src>` per entry whose route answers the entry's files rewritten
// once and wrapped as a function the runtime calls at its run_at point.
// A document no extension reaches gets none of it, but for a page of the
// Chrome Web Store, whose API the runtime defines (webstore.ts).
import { scriptMatches } from '../../extensions/match';
import {
	cleanPath,
	extensionOfURL,
	extensionURL,
} from '../../extensions/origin';
import {
	BACKGROUND_PAGE,
	CONTENT_SCRIPT_ROUTE,
	RUNTIME_GLOBAL,
	serviceWorkerPage,
	type ContextKind,
	type RuntimePayload,
	type ShippedEntry,
	type ShippedExtension,
} from '../../extensions/types';
import { EXTENSION_CHANGES } from '../../transport/messages';
import type { ExtensionRegistry, Loaded, ScriptEntry } from './registry';
import { extensionState, scriptCache } from './store';
import { isStoreURL } from './webstore';
import { worldModule, worldScript } from './worldSource';

declare const self: ServiceWorkerGlobalScope;

/** what the shell of a document is told */
export interface ExtensionShell {
	/** the markup that goes before the inject bundle's script */
	head(loading: string, attribute: string): string;
	/** what the markup is made of (a slot's worker is handed it: ../remoteExtensions.ts) */
	parts: ShellParts;
}

/** a document's shell part as data: the runtime's URL, its payload and the entries' routes */
export interface ShellParts {
	runtime: string;
	/** the payload, as the script's text writes it */
	json: string;
	routes: string[];
}

/** the shell part of `parts` */
export const shellOf = (parts: ShellParts): ExtensionShell => ({
	parts,
	head: (loading, attribute) =>
		`<script${loading} src="${parts.runtime}"></script><script${attribute}>self.${RUNTIME_GLOBAL}?.prepare(${parts.json});</script>${parts.routes
			.map((route) => `<script${loading} src="${route}"></script>`)
			.join('')}`,
});

/** what the worker knows of a document it is about to serve */
export interface ShellDocument {
	/** the real URL */
	url: string;
	/** its service worker client */
	client: string;
	/** The browser-assigned resulting client of a navigation, never a fetch. */
	navigationClient?: string;
	/** the outermost proxied document of its frame */
	top: boolean;
	/** the controller's address */
	directory: string;
	/** a text document served as the HTML Chrome renders it in: the type it came as */
	contentType?: string;
}

export interface ShellDeps {
	/** the runtime asset's URL */
	runtime: string;
	/** a stylesheet of an extension's, rewritten for the proxy (its URL is the file's) */
	rewriteCSS(css: string, url: string): string;
	/** the inject's access API's name (src/helperNames.ts) */
	access: string;
}

// ---- the documents' tokens -------------------------------------------------

let secret: Promise<CryptoKey> | null = null;

function key(): Promise<CryptoKey> {
	secret ??= (async () => {
		let raw = (await extensionState.get('_', 'secret')) as
			Uint8Array | undefined;
		if (!(raw instanceof Uint8Array) || raw.length !== 32) {
			raw = crypto.getRandomValues(new Uint8Array(32));
			await extensionState.put('_', 'secret', raw);
		}
		return crypto.subtle.importKey(
			'raw',
			raw as Uint8Array<ArrayBuffer>,
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		);
	})().catch((error) => {
		secret = null;
		throw error;
	});
	return secret;
}

/**
 * What a content document shows the worker on its calls for an extension:
 * that this worker shipped the extension's scripts to that client. A
 * document of another site never has one (it is written into the shell of a
 * matching document only)
 */
export async function documentToken(id: string, client: string) {
	const signed = await crypto.subtle.sign(
		'HMAC',
		await key(),
		new TextEncoder().encode(`${id}|${client}`),
	);
	return Array.from(new Uint8Array(signed).subarray(0, 18), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
}

// ---- matching --------------------------------------------------------------

function entryMatches(entry: ScriptEntry, url: string, top: boolean) {
	if (!entry.allFrames && !top) return false;
	return scriptMatches(
		{
			matches: entry.matches,
			exclude_matches: entry.excludeMatches,
			include_globs: entry.includeGlobs,
			exclude_globs: entry.excludeGlobs,
		},
		url,
	);
}

/** the route of an entry's function */
export function entryRoute(
	directory: string,
	loaded: Loaded,
	entry: ScriptEntry,
): string {
	return `${directory}${CONTENT_SCRIPT_ROUTE}/${loaded.record.id}/${loaded.record.generation}/${entry.key}.js`;
}

/** an extension page's kind, by its path (the hub names a popup's or offscreen document's frame) */
function pageKind(loaded: Loaded, path: string): ContextKind {
	const background = loaded.record.manifest.background;
	if (
		path === BACKGROUND_PAGE ||
		(background?.service_worker &&
			path === serviceWorkerPage(background.service_worker)) ||
		(background?.page && path === cleanPath(background.page))
	)
		return 'background';
	return 'tab';
}

const escapeScript = (json: string) =>
	json
		.replace(/</g, '\\u003c')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');

/**
 * The shell's part for a document: null when no extension reaches it, so
 * such a document is served exactly as without extensions
 */
export async function documentShell(
	registry: ExtensionRegistry,
	doc: ShellDocument,
	deps: ShellDeps,
): Promise<ExtensionShell | null> {
	// the Web Store's pages have its API with no extension installed (webstore.ts)
	const store = isStoreURL(doc.url);
	if (!registry.any && !store) return null;
	await registry.ready();
	const payload: RuntimePayload = {
		channel: doc.directory,
		client: doc.client,
		url: doc.url,
		top: doc.top,
		tokens: {},
		...(doc.contentType ? { contentType: doc.contentType } : {}),
		access: deps.access,
		...(store && doc.navigationClient
			? {
					store: {
						token: await documentToken(
							`store:${doc.directory}`,
							doc.navigationClient,
						),
						changes: `${EXTENSION_CHANGES}${new URL(self.registration.scope).pathname}`,
					},
				}
			: {}),
	};
	const routes: string[] = [];
	const own = extensionOfURL(doc.url);
	if (own) {
		const loaded = registry.get(own);
		if (!loaded?.record.enabled) return null;
		const path = new URL(doc.url).pathname.replace(/^\/+/, '');
		payload.page = {
			...registry.shipped(loaded),
			kind: pageKind(loaded, path),
		};
		const background = loaded.record.manifest.background;
		if (
			background?.service_worker &&
			path === serviceWorkerPage(background.service_worker)
		)
			payload.serviceWorker = {
				url: extensionURL(own, cleanPath(background.service_worker)),
				module: background.type === 'module',
			};
	} else {
		if (!/^https?:$/.test(new URL(doc.url).protocol)) return null;
		const content: ShippedExtension[] = [];
		// no extension scripts the store's pages, as in Chrome ("The
		// extensions gallery cannot be scripted"): none could press its
		// buttons for the user
		for (const loaded of store ? [] : registry.enabled()) {
			const entries: ShippedEntry[] = [];
			for (const entry of registry.entriesOf(loaded)) {
				if (!entryMatches(entry, doc.url, doc.top)) continue;
				const css = await stylesheets(registry, loaded, entry, doc, deps);
				const js = entry.js.length > 0;
				if (!js && !css) continue;
				entries.push({
					key: entry.key,
					runAt: entry.runAt,
					world: entry.world,
					js,
					css,
					...(entry.local && entry.allFrames ? { local: entry.local } : {}),
				});
				if (js) routes.push(entryRoute(doc.directory, loaded, entry));
			}
			// an extension that may inject into the document (scripting,
			// tabs.executeScript) has its runtime there with no entry
			if (!entries.length && !registry.reaches(loaded, doc.url)) continue;
			// a site its site access withholds: the entries wait for a click
			const blocked =
				entries.length > 0 &&
				!registry.siteGranted(
					loaded,
					doc.url,
					registry.tabOfClient(doc.client ?? undefined),
				);
			content.push({
				...registry.shipped(loaded),
				entries,
				...(blocked ? { blocked: true } : {}),
			});
			if (doc.client)
				payload.tokens[loaded.record.id] = await documentToken(
					loaded.record.id,
					doc.client,
				);
		}
		if (content.length) payload.content = content;
		else if (!store) return null;
	}
	return shellOf({
		runtime: deps.runtime,
		json: escapeScript(JSON.stringify(payload)),
		routes,
	});
}

/** an entry's stylesheets, rewritten for the document's address, kept per worker start */
const cssKept = new Map<string, string>();

async function stylesheets(
	registry: ExtensionRegistry,
	loaded: Loaded,
	entry: ScriptEntry,
	doc: ShellDocument,
	deps: ShellDeps,
): Promise<string> {
	if (!entry.css.length) return '';
	const cacheKey = `${doc.directory}|${loaded.record.id}|${loaded.record.generation}|${entry.key}`;
	let css = cssKept.get(cacheKey);
	if (css === undefined) {
		const parts: string[] = [];
		for (const path of entry.css)
			parts.push(
				deps.rewriteCSS(
					registry.localizeCSS(loaded, await registry.source(loaded, path)),
					extensionURL(loaded.record.id, path),
				),
			);
		css = parts.join('\n');
		if (cssKept.size > 256) cssKept.clear();
		cssKept.set(cacheKey, css);
	}
	return css;
}

// ---- the entries' functions ------------------------------------------------

/**
 * An isolated world's source with its window's `chrome` read as the
 * world's own: `window.chrome`, `self.chrome`, `globalThis.chrome` (and
 * with `?.`) become the function's `chrome`, as an isolated world's window
 * has the extension's (LanguageTool reads `self.chrome.runtime`, Grammarly
 * `window.chrome.runtime.getURL`). What reads it another way while the
 * script runs gets it from the runtime (entry.ts inWorld).
 */
export const isolatedSource = (source: string) =>
	source.replace(
		/(^|[^\w$.])(?:window|self|globalThis)\s*\??\.\s*chrome(?![\w$])/g,
		'$1chrome',
	);

/**
 * A route's script: a call of the runtime's `define` with the code as a
 * function of its world's `chrome` (none in the MAIN world), and of the
 * callback an injection's result goes to (`result`). An injection's
 * function is handed the realm's own indirect eval after it, which runs a
 * file's code as global code and answers its completion value (fileBody)
 */
export function definition(
	id: string,
	key: string,
	world: string,
	body: string,
	result: boolean,
): string {
	const parameters = [
		...(world === 'MAIN' ? [] : ['chrome', 'browser']),
		...(result ? ['$result', '$eval'] : []),
	].join(',');
	return `self.${RUNTIME_GLOBAL}?.define(${JSON.stringify(id)},${JSON.stringify(key)},function(${parameters}){\n${body}\n});`;
}

/**
 * An ISOLATED script's route: a call of the runtime's `define` with the
 * source its world runs (./worldSource.ts worldScript) and the URL it is
 * code at. Not rewritten: the world reaches the page only through its
 * membrane, whose every member is the page's hooked one
 * (src/extensions/runtime/world/)
 */
export const worldDefinition = (
	id: string,
	key: string,
	source: string,
	url: string,
): string =>
	`self.${RUNTIME_GLOBAL}?.define(${JSON.stringify(id)},${JSON.stringify(key)},${JSON.stringify(worldScript(source))},${JSON.stringify(url)});`;

/**
 * The query of an ISOLATED script's route that asks for it as a function
 * of `chrome` run in the page's realm, as before isolated worlds: for a
 * document that can make no world (one whose sandbox lets no script run,
 * where the inject's policy refuses eval: src/inject/dom/sandbox.ts)
 */
export const SHARED = 'shared';

/**
 * An injected file's body (MAIN and USER_SCRIPT worlds): its code, already
 * rewritten, run by the realm's eval as global code, as Chrome runs a file
 * (its declarations are the page's globals), and its completion value is
 * the injection's result (an isolated world's evaluates its code itself)
 */
export const fileBody = (rewritten: string) =>
	`$result($eval(${JSON.stringify(rewritten)}));`;

/** an injection's code as prepareExecution kept it, for its shared form */
export const injectionSource = (route: string) => `${route}?source`;

/** answer an ISOLATED injection's route `?shared`: its kept code, rewritten and wrapped as a function */
async function sharedInjection(
	cache: Cache,
	request: Request,
	rewriteJS: (source: string, url: string) => string,
): Promise<Response> {
	const route = request.url.split('?')[0];
	const source = await cache.match(injectionSource(route));
	const parts = /\/([a-p]{32})\/x\/(x[0-9a-f]+)\.js$/.exec(route);
	if (!source || !parts) return new Response(null, { status: 404 });
	const { code, url } = (await source.json()) as { code: string; url: string };
	const response = new Response(
		definition(
			parts[1],
			parts[2],
			'ISOLATED',
			rewriteJS(isolatedSource(code), url),
			true,
		),
		{ headers: { 'content-type': 'text/javascript; charset=utf-8' } },
	);
	await cache.put(request.url, response.clone());
	return response;
}

/** a world's module route (src/extensions/runtime/world/modules.ts), `<directory>extcs/<id>/<generation>/m/<path>` */
const MODULE_ROUTE = /^\/[^/]+\/([a-p]{32})\/(\d+)\/m\/(.+)$/;

/**
 * The real origin of the document a request came from, as the worker knows
 * its client; null when it cannot name one (no client, or one at no routed
 * URL), which is no origin to expose a file to
 */
export type ClientOrigin = () => Promise<string | null>;

/**
 * Answer a module an isolated world imports: the extension's file as the
 * world's loader links it, if the extension exposed it to the requesting
 * document's origin (web_accessible_resources), as Chrome loads a content
 * script's module. The origin is the request's client's, never one the
 * request names, so a page reads no file it could not fetch
 */
async function worldModuleResponse(
	registry: ExtensionRegistry,
	request: Request,
	parts: RegExpExecArray,
	origin: string | null,
): Promise<Response> {
	const [, id, generation, file] = parts;
	if (!origin) return new Response(null, { status: 404 });
	// kept per origin: what one origin was answered is no other's
	const at = new URL(request.url);
	const key = `${at.origin}${at.pathname}?o=${encodeURIComponent(origin)}`;
	const cache = await caches.open(scriptCache(id));
	const kept = await cache.match(key);
	if (kept) return kept;
	await registry.ready();
	const loaded = registry.get(id);
	let path = '';
	try {
		path = decodeURIComponent(file).replace(/^\/+/, '');
	} catch (error) {
		// a malformed path is no file of the extension's
	}
	if (
		!loaded ||
		!path ||
		!loaded.record.files.includes(path) ||
		!registry.accessible(loaded, path, origin)
	)
		return new Response(null, { status: 404 });
	const url = extensionURL(id, path);
	let body: string;
	try {
		body = worldModule(await registry.source(loaded, path), url);
	} catch (error) {
		body = `({ i: [], b: [], r: [], f: function () { return async function* () { throw new SyntaxError(${JSON.stringify(`STomp could not read the module ${url}`)}); }; } })`;
	}
	const response = new Response(body, {
		headers: {
			'content-type': 'text/javascript; charset=utf-8',
			'cache-control': 'max-age=31536000, immutable',
		},
	});
	if (String(loaded.record.generation) === generation)
		await cache.put(key, response.clone());
	return response;
}

/**
 * Answer `<directory>extcs/<id>/<generation>/<key>.js`: the entry's files,
 * joined (one entry's files share their declarations, as most multi-file
 * entries expect). An ISOLATED entry's are the source its world evaluates
 * (worldDefinition); the others' are rewritten as page code and wrapped as
 * a function of `chrome` (none in the MAIN world). Kept in Cache Storage
 * under the route, so the next document's load of it is a cache read, and
 * the browser's code cache keeps its compile.
 */
export async function contentScriptResponse(
	registry: ExtensionRegistry,
	request: Request,
	path: string,
	rewriteJS: (source: string, url: string) => string,
	clientOrigin: ClientOrigin,
): Promise<Response> {
	const module = MODULE_ROUTE.exec(path);
	if (module)
		return worldModuleResponse(registry, request, module, await clientOrigin());
	// an injection's script (`x/<key>.js`, prepareExecution) is only ever
	// the kept one; an entry's is built on its first load
	const owner = /^\/[^/]+\/([a-p]{32})\//.exec(path);
	if (!owner) return new Response(null, { status: 404 });
	const cache = await caches.open(scriptCache(owner[1]));
	const kept = await cache.match(request.url);
	if (kept) return kept;
	// (an injection's code where no world can be made: sharedInjection)
	const shared = new URL(request.url).searchParams.has(SHARED);
	if (shared && /^\/[^/]+\/[a-p]{32}\/x\//.test(path))
		return sharedInjection(cache, request, rewriteJS);
	const parts = /^\/[^/]+\/([a-p]{32})\/(\d+)\/([mru][0-9a-f]*)\.js$/.exec(
		path,
	);
	if (!parts) return new Response(null, { status: 404 });
	const [, id, generation, entryKey] = parts;
	await registry.ready();
	const loaded = registry.get(id);
	const entry = loaded
		? registry.entriesOf(loaded).find((candidate) => candidate.key === entryKey)
		: undefined;
	if (!loaded || !entry)
		return new Response('/* no such content script */', {
			status: 404,
			headers: { 'content-type': 'text/javascript' },
		});
	const sources: string[] = [];
	for (const file of entry.js)
		sources.push(await registry.source(loaded, file));
	const joined = sources.join('\n;\n');
	const url = extensionURL(
		id,
		!entry.js[0] || entry.js[0].startsWith('\0')
			? 'user_script.js'
			: entry.js[0],
	);
	let body: string;
	try {
		if (entry.world !== 'MAIN' && entry.world !== 'USER_SCRIPT' && !shared)
			return routeResponse(
				worldDefinition(id, entryKey, joined, url),
				request,
				loaded,
				generation,
			);
		body = rewriteJS(
			entry.world === 'MAIN' ? joined : isolatedSource(joined),
			url,
		);
	} catch (error) {
		console.warn(
			`Stomp: the content script ${entry.js.join(', ')} of ${loaded.manifest.name} could not be rewritten:`,
			error,
		);
		body = `throw new SyntaxError(${JSON.stringify(`STomp could not read the content script ${entry.js.join(', ')}`)});`;
	}
	return routeResponse(
		definition(id, entryKey, entry.world, body, false),
		request,
		loaded,
		generation,
	);
}

/** an entry's route's script, kept when it is of the extension's generation now */
async function routeResponse(
	script: string,
	request: Request,
	loaded: Loaded,
	generation: string,
): Promise<Response> {
	const response = new Response(script, {
		headers: {
			'content-type': 'text/javascript; charset=utf-8',
			// the route names the generation: what it answers never changes
			'cache-control': 'max-age=31536000, immutable',
		},
	});
	if (String(loaded.record.generation) === generation)
		await (
			await caches.open(scriptCache(loaded.record.id))
		).put(request.url, response.clone());
	return response;
}
