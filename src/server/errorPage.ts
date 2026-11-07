import type { Config } from '../config';
import { helperNames } from '../helperNames';
import type { RequestErrorKind } from '../transport/messages';

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

/**
 * The host's own page for a document the proxy itself failed to produce
 * (`errorPage` in the config): fetched from the worker's origin without the
 * HTTP cache, given the ErrorInfo as `globalThis.stompError` (or the name
 * `names.error` configures) in a script at
 * the start of its head, and answered with the failure's status, never
 * cached. Null when no page is configured, when it is not on this origin, or
 * when it cannot be fetched: the caller then answers with its built-in page.
 */
export async function hostErrorPage(
	config: Pick<Config, 'errorPage' | 'names'>,
	info: ErrorInfo,
): Promise<Response | null> {
	if (!config.errorPage) return null;
	try {
		const target = new URL(config.errorPage, location.origin);
		if (target.origin !== location.origin) return null;
		const response = await fetch(target.href, { cache: 'no-store' });
		if (!response.ok) return null;
		const html = await response.text();
		const literal = JSON.stringify(info).replace(
			UNSAFE,
			(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
		);
		// under the deployment's name for it (names.error, default stompError)
		const script = `<script>globalThis[${JSON.stringify(
			helperNames(config).error,
		)}] = ${literal};</script>`;
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
