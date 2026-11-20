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
// not say the browser does that (Config syncAnswers); a document that finds
// it so tells the worker, which serves the documents after it with that.
// Measured in Firefox 160, Chrome 157 and WebKitGTK 2.52.4.
import { SYNC_ANSWER_HEADER, SYNC_ASK_MS } from '../../syncAsk';
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
	if (reaches === false) return '';
	// the snapshot's class, whose prototype no page reaches (the
	// XMLHttpRequest module stands another class in for the page)
	const methods = XMLHttpRequest.prototype;
	// (routeURL.ts queueXHR)
	const route = `${client.directory}xhr`;
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
		// the network's answer: the worker hears it once, for the documents
		// after this one
		if (reaches === undefined)
			client.nativeFetch(`${route}?n`, { method: 'POST' }).catch(() => {});
		reaches = false;
		return '';
	}
	reaches = true;
	const text = Reflect.getOwnPropertyDescriptor(methods, 'responseText')!.get!;
	return `; ${Reflect.apply(text, request, []) as string}`;
}
