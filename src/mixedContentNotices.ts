// What Chrome prints for a mixed content notice (../mixedContent.ts), in its
// words. Only the console reads it: the document bundle has it as a
// deferred part (src/inject/dom/deferredParts.ts), made at a document's first
// notice, and the worker bundle carries it (src/inject/mixedContentParts.ts).
// Its top level reads no global.
import type { MixedContentNotice } from './mixedContent';

/** a notice's console level and its sentence, for the page at `page` */
export function noticeText(
	notice: MixedContentNotice,
	page: string,
): { level: 'error' | 'warn'; text: string } {
	const start = `Mixed Content: The page at '${page}' was loaded over HTTPS, but`;
	switch (notice.kind) {
		case 'blocked':
			return {
				level: 'error',
				text: `${start} requested an insecure ${notice.type} '${notice.url}'. This request has been blocked; the content must be served over HTTPS.`,
			};
		case 'upgraded':
			return {
				level: 'warn',
				text: `${start} requested an insecure element '${notice.url}'. This request was automatically upgraded to HTTPS, For more information see https://blog.chromium.org/2019/10/no-more-mixed-messages-about-https.html`,
			};
		case 'not-upgraded-ip':
			return {
				level: 'warn',
				text: `${start} requested an insecure element '${notice.url}'. This request was not upgraded to HTTPS because its URL's host is an IP address.`,
			};
		case 'not-upgraded-local':
			return {
				level: 'warn',
				text: `${start} requested an insecure element '${notice.url}'. This request was not upgraded to HTTPS because it is a local network request.`,
			};
		case 'should-also':
			return {
				level: 'warn',
				text: `${start} requested an insecure ${notice.type} '${notice.url}'. This content should also be served over HTTPS.`,
			};
		case 'form':
			return {
				level: 'warn',
				text: `Mixed Content: The page at '${page}' was loaded over a secure connection, but contains a form that targets an insecure endpoint '${notice.url}'. This endpoint should be made available over a secure connection.`,
			};
		case 'websocket':
			return {
				level: 'error',
				text: `${start} attempted to connect to the insecure WebSocket endpoint '${notice.url}'. This request has been blocked; this endpoint must be available over WSS.`,
			};
	}
}
