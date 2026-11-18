// fetchLater's call (src/inject/dom/modules/Navigator.ts keeps the hook): a
// deferred part of the document bundle (./deferred.ts), made at a
// document's first call, before the browser's fetchLater is called. Its top
// level reads no global (./deferredParts.ts).
import { ROUTE_PROTOCOLS } from '../../routeURL';
import { isRequest } from '../modules/Fetch';
import { catchRequiredArguments } from '../modules/Proxy';
import { withStack } from '../nativeErrors';
import type DocumentClient from './Client';

/** what the hook took before any page script ran */
export interface FetchLaterRealm {
	client: DocumentClient;
	global: typeof globalThis;
	/** each FetchLaterResult the hook made, with whether it was sent */
	states: { set(key: object, value: { activated: boolean }): unknown };
	resultPrototype: object;
	/** the hooked fetch (routed), the browser's setTimeout and listener calls */
	fetch: Function;
	setTimeout: Function;
	add: Function;
	remove: Function;
	/** the browser's Request url getter */
	requestURL: Function;
}

const failed = (message: string) =>
	`Failed to execute 'fetchLater' on 'Window': ${message}`;

/**
 * fetchLater(input, init), made with the page's own fetch (keepalive,
 * routed like any) once `activateAfter` has passed or as the document goes
 * (pagehide), unless its signal aborted first; `target` is the browser's,
 * which refuses what is not deferred here
 */
export function fetchLater(
	{
		client,
		global,
		states,
		resultPrototype,
		fetch,
		setTimeout,
		add,
		remove,
		requestURL,
	}: FetchLaterRealm,
	target: Function,
	that: unknown,
	args: unknown[],
) {
	catchRequiredArguments(args.length, 1, 'Window', 'fetchLater', global);
	const request = isRequest(args[0]) ? args[0] : null;
	let url: URL;
	try {
		url = request
			? new URL(Reflect.apply(requestURL, request, []) as string)
			: new URL(String(args[0]), client.baseHref);
	} catch (error) {
		// the browser's own TypeError for a URL that does not parse
		return Reflect.apply(target, that, args);
	}
	// (no http(s) URL: the browser's own refusal, which sends nothing)
	if (!ROUTE_PROTOCOLS.includes(url.protocol))
		return Reflect.apply(target, that, args);
	const { activateAfter, signal, ...init } = (args[1] ?? {}) as RequestInit & {
		activateAfter?: number;
	};
	// what the browser refuses before it defers anything
	if (activateAfter !== undefined && !(Number(activateAfter) >= 0))
		throw new global.RangeError(
			failed("fetchLater's activateAfter cannot be negative."),
		);
	if (signal?.aborted)
		throw withStack(
			new global.DOMException(
				failed('The user aborted a fetchLater request.'),
				'AbortError',
			),
		);
	if (init.body instanceof global.ReadableStream)
		throw new global.TypeError(
			failed("fetchLater doesn't support body with unknown length."),
		);
	const method = String(
		init.method ?? (request ? Reflect.get(request, 'method') : 'GET'),
	).toUpperCase();
	if (
		(method === 'GET' || method === 'HEAD') &&
		init.body !== undefined &&
		init.body !== null
	)
		throw new global.TypeError(
			failed('Request with GET/HEAD method cannot have body.'),
		);
	const state = { activated: false };
	const result = Object.create(resultPrototype) as object;
	states.set(result, state);
	const send = () => {
		if (state.activated || signal?.aborted) return;
		state.activated = true;
		Reflect.apply(remove, global, ['pagehide', send]);
		const sent = Reflect.apply(fetch, global, [
			request ?? url.href,
			{ ...init, keepalive: true },
		]) as Promise<unknown>;
		// (what the site answers is no one's: fetchLater has no response)
		sent.catch(() => {});
	};
	Reflect.apply(add, global, ['pagehide', send]);
	if (activateAfter !== undefined)
		Reflect.apply(setTimeout, global, [send, Number(activateAfter)]);
	return result;
}
