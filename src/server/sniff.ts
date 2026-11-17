// Chrome's MIME sniff of a navigation's answer (net/base/mime_sniffer.cc),
// as Chrome 157 does it (measured by adversarial-parse-html's mime-sniff
// family). An answer whose type says nothing (none, empty, unknown/unknown,
// application/unknown, */*, a type with no slash) is read as HTML when its
// first 512 bytes, past leading ASCII white space, start with one of the
// tags of the sniff table, compared ASCII case-insensitively and with
// nothing required after the name (`<htmlx>` sniffs). nosniff stops the
// sniff. text/plain is never read as HTML. The worker decides the same
// way, or a body it passes through as not a document is sniffed into one
// by the browser, its scripts unrewritten.

/** how far into the body the sniff looks */
export const SNIFF_BYTES = 512;

const UNKNOWN_MIMES = ['', 'unknown/unknown', 'application/unknown', '*/*'];

/** whether the browser sniffs an answer of MIME essence `mime` */
export const unknownMime = (mime: string) =>
	UNKNOWN_MIMES.includes(mime) || !mime.includes('/');

// the order is Chrome's; <?xml sniffs to an XML document
const SNIFF_TABLE = [
	'<?xml',
	'<!doctype html',
	'<script',
	'<html',
	'<!--',
	'<head',
	'<iframe',
	'<h1',
	'<div',
	'<font',
	'<table',
	'<a',
	'<style',
	'<title',
	'<b',
	'<body',
	'<br',
	'<p',
];

const lower = (byte: number) =>
	byte >= 0x41 && byte <= 0x5a ? byte | 0x20 : byte;

/** what the browser sniffs `bytes` (an answer's first bytes) as */
export function sniffDocument(bytes: Uint8Array): 'html' | 'xml' | null {
	const end = Math.min(bytes.length, SNIFF_BYTES);
	let at = 0;
	// space, tab, LF, VT, FF, CR (not NUL, a no-break space or a BOM)
	while (
		at < end &&
		(bytes[at] === 0x20 || (bytes[at] >= 9 && bytes[at] <= 13))
	)
		at++;
	for (const tag of SNIFF_TABLE) {
		if (end - at < tag.length) continue;
		let i = 0;
		while (i < tag.length && lower(bytes[at + i]) === tag.charCodeAt(i)) i++;
		if (i === tag.length) return tag === '<?xml' ? 'xml' : 'html';
	}
	return null;
}

/** whether `headers` say nosniff (Fetch "determine nosniff") */
export const saysNosniff = (headers: Headers) =>
	(headers.get('x-content-type-options') ?? '')
		.split(',')[0]
		.trim()
		.toLowerCase() === 'nosniff';

/**
 * The type an answer of `contentType` (essence `mime`) that says nosniff
 * has in the browser, where the worker must say it: where the type is
 * nothing the browser can parse (none, empty, no slash, *\/*), text,
 * which it shows as such (a service worker's answer like that is an empty
 * document instead). unknown/unknown and application/unknown keep theirs,
 * and the browser does not show them (null).
 */
export function nosniffType(
	mime: string,
	contentType: string | null,
): string | null {
	if (mime !== '' && mime !== '*/*' && mime.includes('/')) return null;
	const params = contentType?.indexOf(';') ?? -1;
	return `text/plain${params === -1 ? '' : contentType!.slice(params)}`;
}

/**
 * The first `count` bytes of `response`'s body, read from a clone (the
 * response itself is left to be read or passed on).
 */
export async function firstBytes(
	response: Response,
	count = SNIFF_BYTES,
): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array(0);
	const reader = response.clone().body!.getReader();
	const out = new Uint8Array(count);
	let length = 0;
	try {
		while (length < count) {
			const { done, value } = await reader.read();
			if (done) break;
			const take = Math.min(value.length, count - length);
			out.set(value.subarray(0, take), length);
			length += take;
		}
	} catch {
		// the body failed: what came is all there is to sniff (the response
		// itself fails the same way wherever it goes)
	} finally {
		reader.cancel().catch(() => {});
	}
	return out.subarray(0, length);
}
