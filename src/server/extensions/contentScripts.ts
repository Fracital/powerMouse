// Content scripts from the worker (docs/extensions.md "Content scripts"):
// the worker serves the document, so it matches the extensions' entries on
// the document's real URL and writes what runs into the document's shell,
// ahead of the inject bundle: the runtime asset, the payload, and one
// `<script src>` per entry whose route answers the entry's files rewritten
// once and wrapped as a function the runtime calls at its run_at point.
// A document no extension reaches gets none of it.
import { scriptMatches } from '../../extensions/match';
import { extensionOfURL, extensionURL } from '../../extensions/origin';
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
import type { ExtensionRegistry, Loaded, ScriptEntry } from './registry';
import { extensionState, scriptCache } from './store';

/** what the shell of a document is told */
export interface ExtensionShell {
	/** the markup that goes before the inject bundle's script */
	head(loading: string, attribute: string): string;
}

/** what the worker knows of a document it is about to serve */
export interface ShellDocument {
	/** the real URL */
	url: string;
	/** its service worker client */
	client: string;
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
		(background?.page && path === background.page.replace(/^\/+/, ''))
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
	if (!registry.any) return null;
	await registry.ready();
	const payload: RuntimePayload = {
		channel: doc.directory,
		client: doc.client,
		url: doc.url,
		top: doc.top,
		tokens: {},
		...(doc.contentType ? { contentType: doc.contentType } : {}),
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
				url: extensionURL(own, background.service_worker),
				module: background.type === 'module',
			};
	} else {
		if (!/^https?:$/.test(new URL(doc.url).protocol)) return null;
		const content: ShippedExtension[] = [];
		for (const loaded of registry.enabled()) {
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
				});
				if (js) routes.push(entryRoute(doc.directory, loaded, entry));
			}
			// an extension that may inject into the document (scripting,
			// tabs.executeScript) has its runtime there with no entry
			if (!entries.length && !registry.reaches(loaded, doc.url)) continue;
			content.push({ ...registry.shipped(loaded), entries });
			if (doc.client)
				payload.tokens[loaded.record.id] = await documentToken(
					loaded.record.id,
					doc.client,
				);
		}
		if (!content.length) return null;
		payload.content = content;
	}
	const json = escapeScript(JSON.stringify(payload));
	return {
		head: (loading, attribute) =>
			`<script${loading} src="${deps.runtime}"></script><script${attribute}>self.${RUNTIME_GLOBAL}?.prepare(${json});</script>${routes
				.map((route) => `<script${loading} src="${route}"></script>`)
				.join('')}`,
	};
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
 * callback an injection's result goes to (`result`)
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
		...(result ? ['$result'] : []),
	].join(',');
	return `self.${RUNTIME_GLOBAL}?.define(${JSON.stringify(id)},${JSON.stringify(key)},function(${parameters}){\n${body}\n});`;
}

/**
 * Answer `<directory>extcs/<id>/<generation>/<key>.js`: the entry's files,
 * joined (one entry's files share their declarations, as most multi-file
 * entries expect), rewritten as a script of the extension's, and wrapped as
 * a function of `chrome` (none in the MAIN world). Kept in Cache Storage
 * under the route, so the next document's load of it is a cache read, and
 * the browser's code cache keeps its compile.
 */
export async function contentScriptResponse(
	registry: ExtensionRegistry,
	request: Request,
	path: string,
	rewriteJS: (source: string, url: string) => string,
): Promise<Response> {
	// an injection's script (`x/<key>.js`, prepareExecution) is only ever
	// the kept one; an entry's is built on its first load
	const owner = /^\/[^/]+\/([a-p]{32})\//.exec(path);
	if (!owner) return new Response(null, { status: 404 });
	const cache = await caches.open(scriptCache(owner[1]));
	const kept = await cache.match(request.url);
	if (kept) return kept;
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
	let body: string;
	try {
		const joined = sources.join('\n;\n');
		body = rewriteJS(
			entry.world === 'MAIN' ? joined : isolatedSource(joined),
			extensionURL(
				id,
				!entry.js[0] || entry.js[0].startsWith('\0')
					? 'user_script.js'
					: entry.js[0],
			),
		);
	} catch (error) {
		console.warn(
			`Stomp: the content script ${entry.js.join(', ')} of ${loaded.manifest.name} could not be rewritten:`,
			error,
		);
		body = `throw new SyntaxError(${JSON.stringify(`STomp could not read the content script ${entry.js.join(', ')}`)});`;
	}
	const response = new Response(
		definition(id, entryKey, entry.world, body, false),
		{
			headers: {
				'content-type': 'text/javascript; charset=utf-8',
				// the route names the generation: what it answers never changes
				'cache-control': 'max-age=31536000, immutable',
			},
		},
	);
	if (String(loaded.record.generation) === generation)
		await cache.put(request.url, response.clone());
	return response;
}
