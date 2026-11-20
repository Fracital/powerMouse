// The module graphs of a document no service worker controls (an
// about:blank frame or popup, an about:blank another page navigated a
// frame to), a deferred part. Natively such a document's module loads are
// the network's. Here they would reach the proxy origin's own server with a
// route it cannot answer, and a module copied to a blob: URL could not
// resolve the path-absolute routes its static imports carry. So the inject
// loads the graph itself: every module it imports, statically or with
// import(), is fetched through the proxy (loadFetch, as the load it is),
// and copied to a blob: URL whose static imports name their own copies.
// Each module of the realm is copied once, so it is one instance however
// it is imported, as natively one URL is one module.
//
// The routes a rewritten module's static imports carry (js:genericModule,
// a JSON module's binary, a CSS module's css) are found by their shape, and
// a bare specifier by `from` or `import` before it, resolved by the
// document's own import maps (whose targets the inject routed) with
// import.meta.resolve. The graph is fetched whole first, then copied from
// the leaves up. A cycle has no leaf: the import that closes it keeps the
// absolute route, and an import map the inject adds maps that route to the
// copy once it is made. Chrome and WebKit take an import map at any time;
// Firefox takes none once a module of the document loaded, so a cycle fails
// there (uncontrolled-modules suite).
import { proxyBlobURL } from '../../routeURL';
import { BARE_SPECIFIER } from '../../scriptRoutes';
import { scopePrefix } from '../modules/Unroute';
import type DocumentClient from './Client';
import { loadFetch } from './loadGrants';
import { nativeElement, nativeNode } from './modules/DOMHooks';
import { hiddenMutation } from './modules/MutationObserver';
import { sealerNatives } from './sealerNatives';

/** a module fetched: a script's text and the routes its imports name, by the literal that names each, or another module's bytes */
interface Fetched {
	text?: string;
	bytes?: Blob;
	imports: Map<string, string>;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function graph(client: DocumentClient) {
	const origin = new URL(scopePrefix(client)).origin;
	// a static import's route as the rewriter writes it, path-absolute or
	// absolute, in its quotes
	const ROUTED = new RegExp(
		`(["'])((?:${escaped(origin)})?${escaped(client.directory)}(?:js:genericModule|binary|css)[;/][^"'\\\\\\s]*)\\1`,
		'g',
	);
	const BARE = /(\b(?:from|import)\s*)(["'])([^"'\n]+)\2/g;
	// (import() answers a promise of the document's realm: one that rejects
	// unhandled is reported there, as natively, not in the bundle's)
	const RealmPromise = (client.global as typeof globalThis).Promise;
	const fetched = new Map<string, Promise<Fetched>>();
	const copies = new Map<string, string>();
	/** the modules fetched, once each graph's fetch is through */
	const settled = new Map<string, Fetched>();
	const inline = new Map<number, [string, Element | null]>();
	let inlines = 0;
	const mint = (body: string | Blob, type: string) =>
		proxyBlobURL(
			Reflect.apply(sealerNatives!.createObjectURL, sealerNatives!.URL, [
				new sealerNatives!.Blob([body], { type }),
			]) as string,
		);
	const importIn = (url: string) =>
		client.importIn(url) ??
		// @ts-ignore
		import(/* webpackIgnore: true */ url);
	/** what a bare specifier resolves to by the document's import maps, or null */
	let resolver: Promise<(specifier: string) => string> | undefined;
	const resolve = async (specifier: string): Promise<string | null> => {
		resolver ??= importIn(
			mint('export default (s) => import.meta.resolve(s);', 'text/javascript'),
		).then((module) => (module as { default: (s: string) => string }).default);
		try {
			return (await resolver)(specifier);
		} catch (error) {
			// none: the import fails as natively
			return null;
		}
	};
	/** the routes `text`'s static imports name */
	const importsOf = async (text: string): Promise<Map<string, string>> => {
		const imports = new Map<string, string>();
		for (const [, , route] of text.matchAll(ROUTED))
			imports.set(route, new URL(route, origin).href);
		for (const [, , , specifier] of text.matchAll(BARE))
			if (BARE_SPECIFIER.test(specifier) && !imports.has(specifier)) {
				const route = await resolve(specifier);
				if (route?.startsWith(`${origin}${client.directory}`))
					imports.set(specifier, route);
			}
		return imports;
	};
	/** the module at the absolute route `url`, fetched once */
	const fetchOne = (url: string): Promise<Fetched> => {
		let made = fetched.get(url);
		if (!made) {
			const kind = new URL(url).pathname.slice(client.directory.length);
			const script = kind.startsWith('js:');
			made = loadFetch(client, url, script ? 'script cors' : 'copy', {
				credentials: 'same-origin',
			}).then(async (response) => {
				// (a module of another type than its import names fails, as
				// natively: the browser checks a script's, a JSON module's and a
				// CSS module's MIME type)
				if (
					!response.ok ||
					!(
						script
							? /^\s*(?:(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/(?:jscript|livescript))\s*(?:;|$)/i
							: kind.startsWith('css')
								? /^\s*text\/css\s*(?:;|$)/i
								: /^\s*(?:(?:application|text)\/json|[\w.+-]+\/[\w.+-]+\+json)\s*(?:;|$)/i
					).test(response.headers.get('content-type') ?? '')
				)
					throw new TypeError(`${response.status}`);
				if (!script)
					return { bytes: await response.blob(), imports: new Map() };
				const text = await response.text();
				return { text, imports: await importsOf(text) };
			});
			fetched.set(url, made);
		}
		return made;
	};
	/** every module `imports` leads to, fetched (throws when one fails) */
	const fetchAll = async (imports: Map<string, string>) => {
		const seen = new Set<string>();
		let level = [...imports.values()];
		while (level.length) {
			const next: string[] = [];
			const urls = [...new Set(level)].filter(
				(url) => !seen.has(url) && !!seen.add(url),
			);
			const modules = await Promise.all(urls.map(fetchOne));
			urls.forEach((url, at) => {
				settled.set(url, modules[at]);
				next.push(...modules[at].imports.values());
			});
			level = next;
		}
	};
	/** `text` with each import naming its copy (`closing`: the routes an import closes a cycle to) */
	const withCopies = (
		text: string,
		imports: Map<string, string>,
		visiting: Set<string>,
		closing: Set<string>,
	): string => {
		const copy = (literal: string) => {
			const url = imports.get(literal)!;
			if (!visiting.has(url)) return copyOf(url, visiting, closing);
			closing.add(url);
			return url;
		};
		return text
			.replace(ROUTED, (_, quote, route) => `${quote}${copy(route)}${quote}`)
			.replace(BARE, (match, lead, quote, specifier) =>
				imports.has(specifier)
					? `${lead}${quote}${copy(specifier)}${quote}`
					: match,
			);
	};
	/** the copy of the fetched module at `url`, made once its imports' are */
	const copyOf = (
		url: string,
		visiting: Set<string>,
		closing: Set<string>,
	): string => {
		let copy = copies.get(url);
		if (copy) return copy;
		// (fetched whole before any copy: each is settled)
		const module = settled.get(url)!;
		if (module.text === undefined)
			copy = mint(module.bytes!, module.bytes!.type);
		else {
			visiting.add(url);
			copy = mint(
				withCopies(module.text, module.imports, visiting, closing),
				'text/javascript',
			);
			visiting.delete(url);
		}
		copies.set(url, copy);
		return copy;
	};
	/** the copy of a module whose text and imports are these, made once every module it leads to is fetched */
	const copyGraph = async (
		text: string | null,
		imports: Map<string, string>,
		url = '',
	): Promise<string> => {
		await fetchAll(imports);
		const closing = new Set<string>();
		const copy =
			text === null
				? copyOf(url, new Set(), closing)
				: mint(
						withCopies(text, imports, new Set(), closing),
						'text/javascript',
					);
		if (closing.size) {
			// a route that closes a cycle names its copy by an import map
			const doc = client.global.document;
			const map = doc.createElement('script');
			nativeElement.setAttribute.call(map, 'type', 'importmap');
			Reflect.getOwnPropertyDescriptor(nativeNode, 'textContent')!.set!.call(
				map,
				JSON.stringify({
					imports: Object.fromEntries(
						[...closing].map((route) => [route, copies.get(route)]),
					),
				}),
			);
			hiddenMutation(() => {
				nativeNode.appendChild.call(doc.documentElement!, map);
				nativeNode.removeChild.call(doc.documentElement!, map);
			});
		}
		return copy;
	};
	/** the copy of the module at the absolute route `url` and of everything it imports */
	const load = async (url: string): Promise<string> => {
		const copy = copies.get(url);
		if (copy) return copy;
		return copyGraph(null, new Map([['', url]]), url);
	};
	return {
		load,
		/** import `specifier` (a route, or a bare one the import maps resolve) in the document; anything else as `native` imports it */
		import: (
			specifier: string,
			native: () => Promise<unknown> | null,
		): Promise<unknown> =>
			new RealmPromise((done, fail) =>
				(async () => {
					const route = BARE_SPECIFIER.test(specifier)
						? await resolve(specifier)
						: new URL(specifier, origin).href;
					return route?.startsWith(`${origin}${client.directory}`)
						? importIn(await load(route))
						: // @ts-ignore
							(native() ?? import(/* webpackIgnore: true */ specifier));
				})().then(done, fail),
			),
		/** what an inline module's rewritten `text` in `script` (null: markup's, found by the stub) runs instead: a stub that runs it once its imports are copied */
		inline: (text: string, script: Element | null): string => {
			inline.set(++inlines, [text, script]);
			return `await ${client.names.client}.runModule(${inlines});`;
		},
		run: async (token: number) => {
			const entry = inline.get(token);
			if (!entry) return;
			inline.delete(token);
			const [text, script] = entry;
			let copy: string;
			try {
				copy = await copyGraph(text, await importsOf(text));
			} catch (error) {
				// an import that does not load: the script fires error, as
				// natively, and runs nothing
				const stub = `.runModule(${token});`;
				const target =
					script ??
					[...client.global.document.getElementsByTagName('script')].find(
						(element) =>
							Reflect.getOwnPropertyDescriptor(nativeNode, 'textContent')!
								.get!.call(element)
								?.includes(stub),
					);
				if (target)
					nativeNode.dispatchEvent.call(
						target,
						new (client.global as typeof globalThis).Event('error'),
					);
				return;
			}
			await importIn(copy);
		},
	};
}

const graphs = new WeakMap<DocumentClient, ReturnType<typeof graph>>();

/** the module graphs of `client`'s document */
export function moduleGraph(client: DocumentClient) {
	let made = graphs.get(client);
	if (!made) graphs.set(client, (made = graph(client)));
	return made;
}

export type ModuleGraph = ReturnType<typeof graph>;
