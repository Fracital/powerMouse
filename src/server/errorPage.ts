import type { Config } from '../config';
import { helperNames } from '../helperNames';
import {
	CLIENT_ID,
	NAVIGATE,
	type NavigateInfo,
	type RequestErrorKind,
} from '../transport/messages';

/** the requests whose failure shows a document to the user */
export const DOCUMENT_DESTINATIONS = new Set(['document', 'iframe', 'frame']);

export interface ErrorInfo {
	/** the real URL the page asked for */
	url: string;
	/** the status the document is served with (502 for a transport failure, which the request report counts as 0) */
	status: number;
	/** the message the request report carries */
	error: string;
	kind: RequestErrorKind;
}

/** every character that could end the script element or break the literal */
const UNSAFE = /[<>&\u2028\u2029]/g;

const scriptLiteral = (value: unknown) =>
	JSON.stringify(value).replace(
		UNSAFE,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
	);

/**
 * The script a page the worker answers a failed document with runs in its
 * head: it tells the host where the frame is, as a proxied document's
 * inject does (src/inject/dom/modules/Navigate.ts), since the page runs no
 * inject. A navigate report with `url` (the real URL that failed) and the
 * page's title, once the page's own scripts ran (DOMContentLoaded) and again
 * whenever the title changes, with `client` (the document's service worker
 * client, which the worker knows from the navigation) so the host gives the
 * failed request's report to the frame. The same message names the client
 * under CLIENT_ID, which is all the host takes from a document in a frame of
 * a proxied page. It posts from the page's own window to the real top,
 * where the controller finds the frame by the message's source as for any
 * proxied document, so it can speak for no frame but its own. Wrapped in a
 * function: the page's own classic scripts share the global scope.
 */
export function errorReportScript(url: string, client?: string): string {
	const info: NavigateInfo = {
		url,
		title: '',
		canGoBack: null,
		canGoForward: null,
		icon: null,
		...(client ? { client } : {}),
	};
	const message = {
		[NAVIGATE]: info,
		...(client ? { [CLIENT_ID]: client } : {}),
	};
	return `<script>(() => {
	const host = top;
	if (host === self) return;
	const send = host.postMessage;
	const message = ${scriptLiteral(message)};
	let last = null;
	const report = () => {
		const title = document.title;
		if (title === last) return;
		last = title;
		message[${JSON.stringify(NAVIGATE)}].title = title;
		try {
			Reflect.apply(send, host, [message, '*']);
		} catch (error) {}
	};
	addEventListener('DOMContentLoaded', () => {
		report();
		new MutationObserver(report).observe(document, {
			subtree: true,
			childList: true,
			characterData: true,
		});
	}, { once: true });
})();</script>`;
}

/**
 * The host's own page for a document the proxy itself failed to produce
 * (`errorPage` in the config): fetched from the worker's origin without the
 * HTTP cache, given the ErrorInfo as `globalThis.stompError` (or the name
 * `names.error` configures) in a script at
 * the start of its head, and answered with the failure's status, never
 * cached. Null when no page is configured, when it is not on this origin, or
 * when it cannot be fetched: the caller then answers with its built-in page.
 * With `report`, the page also gets errorReportScript, with the client
 * `report.client`: given whenever `info.url` is the real URL and a host may
 * hear the report.
 */
export async function hostErrorPage(
	config: Pick<Config, 'errorPage' | 'names'>,
	info: ErrorInfo,
	report?: { client?: string },
): Promise<Response | null> {
	if (!config.errorPage) return null;
	try {
		const target = new URL(config.errorPage, location.origin);
		if (target.origin !== location.origin) return null;
		const response = await fetch(target.href, { cache: 'no-store' });
		if (!response.ok) return null;
		const html = await response.text();
		// under the deployment's name for it (names.error, default stompError)
		const script = `<script>globalThis[${JSON.stringify(
			helperNames(config).error,
		)}] = ${scriptLiteral(info)};</script>${
			report ? errorReportScript(info.url, report.client) : ''
		}`;
		const body = /<head[^>]*>/i.test(html)
			? html.replace(/<head[^>]*>/i, (head) => `${head}${script}`)
			: `${script}${html}`;
		return new Response(body, {
			status: info.status,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
			},
		});
	} catch (error) {
		return null;
	}
}
