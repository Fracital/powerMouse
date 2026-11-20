// The worker's two doors to its extension backend (docs/extensions.md
// "Architecture"): the controllers' `extensions` RPC (install, list,
// enable, remove, update) and the contexts' `<directory>extapi` route
// (chrome.storage, dynamic rules, registered scripts, cookies, management,
// webRequest listeners, a service worker's fetch handler, scripts to
// inject). A context's call is a fetch
// from its own document, so the worker knows its client: an extension page
// is the extension's by its URL, a content document shows the token its
// shell was given.
import { extensionOfURL, extensionURL } from '../../extensions/origin';
import {
	CONTENT_SCRIPT_ROUTE,
	ExtensionError,
	type ExtensionCommand,
	type WebRequestListener,
} from '../../extensions/types';
import {
	definition,
	documentToken,
	injectionSource,
	isolatedSource,
	worldDefinition,
} from './contentScripts';
import { fetchEvents } from './fetchEvents';
import type { ExtensionRegistry } from './registry';
import { scriptCache } from './store';
import { webRequests } from './webRequest';

declare const self: ServiceWorkerGlobalScope;

/** an error as the RPC carries it (a message only): `[ext:<code>] <message>` */
export function errorText(error: unknown): string {
	if (error instanceof ExtensionError)
		return `[ext:${error.code}] ${error.message}`;
	return error instanceof Error ? error.message : String(error);
}

/** a controller's command */
export async function extensionCommand(
	registry: ExtensionRegistry,
	command: ExtensionCommand,
	download: (url: string) => Promise<Uint8Array>,
): Promise<unknown> {
	try {
		switch (command.op) {
			case 'install':
				return await registry.install(command, download);
			case 'list':
				return await registry.list();
			case 'get':
				return await registry.infoOf(command.id);
			case 'enable': {
				const info = await registry.setEnabled(command.id, command.enabled);
				if (!command.enabled) {
					webRequests.forget(command.id);
					fetchEvents.forget(command.id);
				}
				return info;
			}
			case 'remove':
				webRequests.forget(command.id);
				fetchEvents.forget(command.id);
				await registry.remove(command.id);
				return undefined;
			case 'update':
				return await registry.update(command.id, download);
			case 'storage':
				return await registry.storage(
					command.id,
					command.area,
					command.call,
					command.args,
				);
			case 'dnr':
				return await registry.dnrCall(command.id, command.call, command.args);
			case 'place':
				registry.placeClient(String(command.client), Number(command.tabId));
				return undefined;
			case 'expect':
				registry.expectNavigation(String(command.url), Number(command.tabId));
				return undefined;
			case 'frame':
				return registry.frameIdOf(String(command.client));
			case 'sameFrame':
				registry.linkFrame(String(command.client), String(command.previous));
				return undefined;
			case 'grant':
				registry.grantActiveTab(String(command.id), Number(command.tabId));
				return undefined;
			default:
				throw new ExtensionError(
					'unsupported',
					`${(command as { op: string }).op} is not an extensions command.`,
				);
		}
	} catch (error) {
		throw new Error(errorText(error), { cause: error });
	}
}

/** what a context's call is allowed: an extension page all its extension may, a content document its storage */
type Standing = 'page' | 'content' | null;

const standings = new Map<string, Standing>();

async function standingOf(
	registry: ExtensionRegistry,
	id: string,
	client: string,
	token: unknown,
	realURL: (routed: string) => string,
): Promise<Standing> {
	const kept = standings.get(`${id}|${client}`);
	if (kept) return kept;
	let standing: Standing = null;
	const found = client ? await self.clients.get(client) : undefined;
	if (found && extensionOfURL(realURL(found.url)) === id) standing = 'page';
	else if (
		typeof token === 'string' &&
		client &&
		token === (await documentToken(id, client))
	)
		standing = 'content';
	if (standing) {
		standings.set(`${id}|${client}`, standing);
		if (standings.size > 2048) standings.delete(standings.keys().next().value!);
	}
	return standing;
}

interface ApiCall {
	ext: string;
	token?: string;
	/** the calling context's id (webRequest's registrations) */
	context?: string;
	area: string;
	call: string;
	args: unknown[];
}

const CONTENT_AREAS = new Set(['storage']);

/** answer a context's `extapi` call */
export async function extensionApi(
	registry: ExtensionRegistry,
	request: Request,
	client: string | undefined,
	channel: string,
	realURL: (routed: string) => string,
	rewriteJS: (source: string, url: string) => string,
	rewriteCSS: (css: string, file: string) => string,
): Promise<Response> {
	const reply = (status: number, body: unknown) =>
		new Response(JSON.stringify(body ?? null), {
			status,
			headers: {
				'content-type': 'application/json',
				'cache-control': 'no-store',
			},
		});
	if (request.method !== 'POST') return reply(405, { error: 'POST only' });
	let call: ApiCall;
	try {
		call = (await request.json()) as ApiCall;
	} catch (error) {
		return reply(400, { error: 'The call is not JSON.' });
	}
	const id = String(call?.ext ?? '');
	const standing = await standingOf(
		registry,
		id,
		client ?? '',
		call.token,
		realURL,
	);
	if (!standing || (standing === 'content' && !CONTENT_AREAS.has(call.area)))
		return reply(403, {
			error: `This context may not call ${call.area}.${call.call} of ${id}.`,
		});
	const args = Array.isArray(call.args) ? call.args : [];
	try {
		let value: unknown;
		switch (call.area) {
			case 'storage':
				if (
					standing === 'content' &&
					String(args[0]) === 'session' &&
					!(await registry.sessionOpen(id))
				)
					throw new ExtensionError(
						'unsupported',
						'Access to storage is not allowed from this context.',
					);
				value = await registry.storage(
					id,
					String(args[0]),
					call.call,
					args.slice(1),
				);
				break;
			case 'dnr':
				value = await registry.dnrCall(id, call.call, args);
				break;
			case 'scripting':
				value = await registry.scripting(id, call.call, args);
				break;
			case 'userScripts':
				value = await registry.userScripts(id, call.call, args);
				break;
			case 'permissions':
				value = await registry.permissions(id, call.call, args);
				break;
			case 'cookies':
				value = await registry.cookieCall(id, call.call, args);
				break;
			case 'management':
				value = await registry.management(id, call.call, args);
				break;
			case 'runtime':
				if (call.call === 'ranVersion') value = await registry.ranVersion(id);
				else throw new ExtensionError('unsupported', `runtime.${call.call}`);
				break;
			case 'webRequest': {
				const loaded = registry.get(id);
				await webRequests.register(
					String(call.context ?? client ?? ''),
					channel,
					id,
					(args[0] as WebRequestListener[]) ?? [],
					!!loaded?.blocking,
				);
				value = undefined;
				break;
			}
			case 'serviceWorker':
				// the page an MV3 worker runs in has a fetch handler, or none
				await fetchEvents.register(
					String(call.context ?? client ?? ''),
					channel,
					id,
					!!args[0],
				);
				value = undefined;
				break;
			case 'css': {
				// insertCSS / removeCSS: the files' or the code's text, localized
				// and rewritten as the extension's stylesheet
				const source = (args[0] ?? {}) as { files?: string[]; code?: string };
				const loaded = registry.get(id);
				if (!loaded)
					throw new ExtensionError('not-found', `No extension ${id}.`);
				let text = typeof source.code === 'string' ? source.code : '';
				let file = 'injected.css';
				for (const path of source.files ?? []) {
					const clean = path.replace(/^\/+/, '');
					if (!loaded.record.files.includes(clean))
						throw new ExtensionError(
							'not-found',
							`Could not load file: '${path}'.`,
						);
					text += `\n${await registry.source(loaded, clean)}`;
					file = clean;
				}
				value = rewriteCSS(
					registry.localizeCSS(loaded, text),
					extensionURL(id, file),
				);
				break;
			}
			case 'execute':
				value = await prepareExecution(
					registry,
					id,
					channel,
					args[0] as ExecuteSource,
					rewriteJS,
				);
				break;
			default:
				throw new ExtensionError('unsupported', `${call.area} is not an area.`);
		}
		return reply(200, { value: value ?? null });
	} catch (error) {
		return reply(200, {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** what scripting.executeScript / tabs.executeScript run: files of the extension's, or code */
export interface ExecuteSource {
	files?: string[];
	code?: string;
	world?: 'ISOLATED' | 'MAIN' | 'USER_SCRIPT';
}

async function digest(text: string): Promise<string> {
	const hash = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text),
	);
	return Array.from(new Uint8Array(hash).subarray(0, 16), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
}

/**
 * A script to inject, rewritten and kept under a route of its own
 * (`<directory>extcs/<id>/x/<hash>.js`): the target document loads it as a
 * script element (no string becomes code in the page, whatever its policy
 * says of eval), and it defines a function the runtime calls
 */
async function prepareExecution(
	registry: ExtensionRegistry,
	id: string,
	channel: string,
	source: ExecuteSource,
	rewriteJS: (source: string, url: string) => string,
): Promise<{ route: string; key: string }> {
	await registry.ready();
	const loaded = registry.get(id);
	if (!loaded) throw new ExtensionError('not-found', `No extension ${id}.`);
	let code: string;
	let file = '';
	if (typeof source?.code === 'string') code = source.code;
	else if (source?.files?.length) {
		const parts: string[] = [];
		for (const path of source.files) {
			const clean = path.replace(/^\/+/, '');
			if (!loaded.record.files.includes(clean))
				throw new ExtensionError(
					'not-found',
					`Could not load file: '${path}'.`,
				);
			parts.push(await registry.source(loaded, clean));
		}
		code = parts.join('\n;\n');
		file = source.files[0].replace(/^\/+/, '');
	} else
		throw new ExtensionError(
			'bad-source',
			'Exactly one of func and files must be specified.',
		);
	const world =
		source.world === 'MAIN' || source.world === 'USER_SCRIPT'
			? source.world
			: 'ISOLATED';
	const key = `x${await digest(`${world}\n${code}`)}`;
	const route = `${channel}${CONTENT_SCRIPT_ROUTE}/${id}/x/${key}.js`;
	const url = new URL(route, location.origin).href;
	const cache = await caches.open(scriptCache(id));
	if (!(await cache.match(url))) {
		// the last expression's value is the result, as Chrome reports it:
		// the code's completion value becomes the function's return (an
		// isolated world's code is its world's: worldDefinition)
		const at = extensionURL(id, file || 'injected.js');
		const script =
			world === 'ISOLATED'
				? worldDefinition(id, key, code, at)
				: definition(
						id,
						key,
						world,
						rewriteJS(world === 'MAIN' ? code : isolatedSource(code), at),
						true,
					);
		await cache.put(
			url,
			new Response(script, {
				headers: { 'content-type': 'text/javascript; charset=utf-8' },
			}),
		);
		// (and the code, for a document that makes no world: SHARED)
		if (world === 'ISOLATED')
			await cache.put(
				injectionSource(url),
				new Response(JSON.stringify({ code, url: at }), {
					headers: { 'content-type': 'application/json' },
				}),
			);
	}
	return { route, key };
}
