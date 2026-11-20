// The answer to a request of the synchronous bridge (./modules/Sync.ts),
// asked for with a synchronous XMLHttpRequest of the page's own. A deferred
// part (./deferred.ts): the bridge's spin reads it with the cookies.
//
// The bridge's answer comes in cookies the service worker sets while the
// page spins on document.cookie. Firefox shows a spinning page no cookie set
// after its spin began, and holds the worker's every look at that page's
// window until the spin ends, so each answer came only once the page had
// given up (30 s for a request, 10 s for storage, 5 s for a script's copy).
// A synchronous request of the page's own reaches its worker in Firefox,
// which answers it with the cookies' text (src/server/Sync.ts answers),
// and Firefox runs the rest meanwhile. Chrome and WebKit send it to the
// network, past the worker, so a document asks only while its config does
// not say the browser does that (Config syncAnswers). One whose config does
// not say first finds out with a HEAD for the rewriter library's file
// (SYNC_PROBE_HEADER), which the worker answers itself and the host's
// server answers as the file it serves: the ask's own address is no file
// of the host's, and Chrome logged its 404 in every such document's console
// (at the bridge's code, in rewriterLib.js). A document that finds the
// browser sends it past tells the worker, which serves the documents after
// it with that. Measured in Firefox 160, Chrome 157 and WebKitGTK 2.52.4.
import { rewriterLibJS } from '../../routeURL';
import {
	SYNC_ANSWER_HEADER,
	SYNC_ASK_MS,
	SYNC_PROBE_HEADER,
} from '../../syncAsk';
import type DocumentClient from './Client';

/** what this realm found: whether its ask reached the worker */
let reaches: boolean | undefined;

/**
 * The cookies of the answer to the bridge's request `id` from the worker,
 * after a `; ` (to follow document.cookie's), waiting for it a while (at
 * most SYNC_ASK_MS, never past `deadline`, so the spin goes on between two
 * asks); "" where the browser sends the ask past the worker, or where the
 * answer did not come in that while
 */
export function syncAnswer(
	client: DocumentClient,
	id: string,
	deadline: number,
): string {
	reaches ??= client.syncAnswers;
	// the snapshot's class, whose prototype no page reaches (the
	// XMLHttpRequest module stands another class in for the page)
	const methods = XMLHttpRequest.prototype;
	// (routeURL.ts queueXHR)
	const route = `${client.directory}xhr`;
	if (reaches === undefined) {
		const found = probeReaches(client, methods);
		// the browser sends it past: the worker hears it once, for the
		// documents after this one
		if (found === false)
			client.nativeFetch(`${route}?n`, { method: 'POST' }).catch(() => {});
		reaches = found ?? false;
	}
	if (!reaches) return '';
	const wait = Math.min(SYNC_ASK_MS, deadline - Date.now());
	const request = new XMLHttpRequest();
	try {
		Reflect.apply(methods.open, request, [
			'GET',
			`${route}?a=${id}&w=${Math.max(0, wait)}`,
			false,
		]);
		Reflect.apply(methods.send, request, []);
	} catch (error) {
		// refused (a policy of the page's, a network error): the cookies yet
		return '';
	}
	if (
		Reflect.apply(methods.getResponseHeader, request, [SYNC_ANSWER_HEADER]) !==
		'1'
	) {
		// not the worker's answer: this realm asks no more
		reaches = false;
		return '';
	}
	const text = Reflect.getOwnPropertyDescriptor(methods, 'responseText')!.get!;
	return `; ${Reflect.apply(text, request, []) as string}`;
}

/**
 * Whether a synchronous request of this document reaches its worker: a
 * HEAD for the rewriter library's file, marked, which the worker answers
 * itself, and which past the worker the host answers as the file (no error
 * in the console, no body); null when the request is refused
 */
function probeReaches(
	client: DocumentClient,
	methods: typeof XMLHttpRequest.prototype,
): boolean | null {
	const request = new XMLHttpRequest();
	try {
		Reflect.apply(methods.open, request, [
			'HEAD',
			rewriterLibJS(client.url, client.config),
			false,
		]);
		Reflect.apply(methods.setRequestHeader, request, [SYNC_PROBE_HEADER, '1']);
		Reflect.apply(methods.send, request, []);
	} catch (error) {
		// (a policy of the page's, a network error): nothing learned
		return null;
	}
	return (
		Reflect.apply(methods.getResponseHeader, request, [SYNC_ANSWER_HEADER]) ===
		'1'
	);
}
