// A text document Chrome shows (a JSON answer, a text file, a script opened
// as a page) is a document too: Chrome renders its text into a <pre>, and
// an extension's content scripts run in it as in any page. For a document
// an extension reaches, the worker serves that markup through the HTML
// shell (the extension's runtime and entries load in it); every other text
// answer passes through untouched, as Chrome renders it itself.

/** types Chrome downloads though they are text/* (net's kUnsupportedTextTypes) */
export const DOWNLOADED_TEXT = new Set([
	'text/calendar',
	'text/x-calendar',
	'text/x-vcalendar',
	'text/vcalendar',
	'text/vcard',
	'text/x-vcard',
	'text/directory',
	'text/ldif',
	'text/qif',
	'text/x-qif',
	'text/x-csv',
	'text/x-vcf',
	'text/rtf',
	'text/comma-separated-values',
	'text/csv',
	'text/tab-separated-values',
	'text/tsv',
	'text/ofx',
	'text/vnd.sun.j2me.app-descriptor',
	'text/x-ms-iqy',
	'text/x-ms-odc',
	'text/x-ms-rqy',
	'text/x-ms-contact',
]);

/** Blink's JavaScript types, which it shows as text */
const SCRIPT_TYPES = new Set([
	'application/ecmascript',
	'application/javascript',
	'application/x-ecmascript',
	'application/x-javascript',
	'text/ecmascript',
	'text/javascript',
	'text/javascript1.0',
	'text/javascript1.1',
	'text/javascript1.2',
	'text/javascript1.3',
	'text/javascript1.4',
	'text/javascript1.5',
	'text/jscript',
	'text/livescript',
	'text/x-ecmascript',
	'text/x-javascript',
]);

/**
 * how Chrome shows a navigation of `mime` (its essence, lowercased): as a
 * JSON document, as plain text, or not as text at all (null: HTML, XML,
 * anything else)
 */
export function textDocumentKind(mime: string): 'json' | 'text' | null {
	if (
		mime === 'application/json' ||
		mime === 'text/json' ||
		(mime.startsWith('application/') && mime.endsWith('+json'))
	)
		return 'json';
	if (SCRIPT_TYPES.has(mime)) return 'text';
	if (
		mime.startsWith('text/') &&
		mime !== 'text/html' &&
		mime !== 'text/xml' &&
		mime !== 'text/xsl' &&
		!DOWNLOADED_TEXT.has(mime)
	)
		return 'text';
	return null;
}

// the markup Chrome's text documents have, as Chrome 157 serializes them
// (the leading newline after <pre> is the parser's to drop, so a text that
// starts with one keeps it)
const HEADS = {
	json: '<html><head><meta name="color-scheme" content="light dark"><meta charset="utf-8"></head><body><pre>\n',
	text: '<html><head><meta name="color-scheme" content="light dark"></head><body><pre style="word-wrap: break-word; white-space: pre-wrap;">\n',
};
const TAILS = {
	json: '</pre><div class="json-formatter-container"></div></body></html>',
	text: '</pre></body></html>',
};

/** text as a text node's markup: a NUL reads as U+FFFD, as Chrome's text parser makes it */
const escapeText = (text: string) =>
	text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/\0/g, '�');

/** the label a Content-Type's charset names, or UTF-8 */
function charsetOf(contentType: string | null): string {
	const found = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? '');
	if (found)
		try {
			return new TextDecoder(found[1]).encoding;
		} catch (error) {
			// a label no decoder knows: Chrome falls back as for none
		}
	return 'utf-8';
}

/**
 * the HTML of a text document Chrome would render from `body`, as UTF-8
 * bytes, streamed as the body comes (a large JSON answer is written as it
 * arrives, as Chrome parses it)
 */
export function textDocumentBody(
	body: ReadableStream<Uint8Array> | null,
	contentType: string | null,
	kind: 'json' | 'text',
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder(charsetOf(contentType));
	const reader = body?.getReader() ?? null;
	let opened = false;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (!opened) {
				opened = true;
				controller.enqueue(encoder.encode(HEADS[kind]));
				return;
			}
			const read = reader ? await reader.read() : { done: true as const };
			if (read.done) {
				const rest = decoder.decode();
				controller.enqueue(encoder.encode(escapeText(rest) + TAILS[kind]));
				controller.close();
				return;
			}
			const text = decoder.decode(read.value, { stream: true });
			if (text) controller.enqueue(encoder.encode(escapeText(text)));
		},
		cancel(reason) {
			return reader?.cancel(reason);
		},
	});
}
