// What a navigation's answer leaves on the screen. Chrome commits no
// document for some answers: the frame keeps the one it has, and its load
// is over (the tab's Stop turns back into Reload at once). The service
// worker tells the host of such an answer (src/server/rewrites.ts).

import { DOWNLOADED_TEXT } from './server/extensions/textDocument';

/** application/* types Blink shows (as a document, as text, in its viewer) */
const SHOWN_APPLICATION =
	/^application\/(?:xhtml\+xml|xml|json|pdf|ecmascript|javascript|x-ecmascript|x-javascript|[\w.+-]+\+(?:xml|json))$/;

/**
 * How Chrome takes a navigation answered with `status` and these headers:
 * `nothing` for a 204 or a 205 (no document, no download), `download` for
 * an attachment or a type it does not show, null for a document. A type it
 * may show (text, images, audio and video, the types above, or none, which
 * it sniffs) counts as a document.
 */
export function navigationAnswer(
	status: number,
	contentType: string | null,
	disposition: string | null,
): 'nothing' | 'download' | null {
	if (status === 204 || status === 205) return 'nothing';
	if (status >= 300 && status < 400) return null;
	if (/^\s*attachment\s*(?:;|$)/i.test(disposition ?? '')) return 'download';
	const mime = (contentType ?? '').split(';')[0].trim().toLowerCase();
	if (!mime || mime === 'multipart/x-mixed-replace') return null;
	if (mime.startsWith('text/'))
		return DOWNLOADED_TEXT.has(mime) ? 'download' : null;
	if (/^(?:image|audio|video)\//.test(mime)) return null;
	if (SHOWN_APPLICATION.test(mime)) return null;
	return 'download';
}
