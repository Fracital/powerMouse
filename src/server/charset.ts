// Decoding a document's bytes the way the browser would have, before the
// rewriter sees it. The order is the HTML standard's: a byte order mark, then
// the Content-Type charset, then a prescan of the first 1024 bytes for
// `<meta charset>` or `<meta http-equiv="content-type">`, then UTF-8. The
// rewritten document is always served as UTF-8, so the shell's own charset
// declaration and the header agree.

const PRESCAN_BYTES = 1024;

/** the label the HTML parser would start with, or null for "no idea" */
export function sniffCharset(
	bytes: Uint8Array,
	contentType: string | null,
): string | null {
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xef &&
		bytes[1] === 0xbb &&
		bytes[2] === 0xbf
	)
		return 'utf-8';
	if (bytes.length >= 2) {
		if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
		if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
	}

	const fromHeader = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType || '');
	if (fromHeader) return fromHeader[1];

	// the prescan only has to find ASCII, so a Latin-1 view of the bytes is fine
	let head = '';
	const end = Math.min(bytes.length, PRESCAN_BYTES);
	for (let i = 0; i < end; i++) head += String.fromCharCode(bytes[i]);
	const metaCharset =
		/<meta[^>]*?\scharset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(head);
	if (metaCharset) return metaCharset[1];
	const metaContent =
		/<meta[^>]*?http-equiv\s*=\s*["']?content-type["']?[^>]*?content\s*=\s*["']?[^"'>]*?charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(
			head,
		);
	if (metaContent) return metaContent[1];
	const xml = /^<\?xml[^>]*?encoding\s*=\s*["']([a-z0-9_:.-]+)/i.exec(head);
	if (xml) return xml[1];
	return null;
}

/** the document as text, decoded with the charset it declares */
export function decodeDocument(
	bytes: Uint8Array,
	contentType: string | null,
): string {
	let label = sniffCharset(bytes, contentType) || 'utf-8';
	// the standard maps the UTF-16 labels to UTF-8 when they come from a
	// declaration rather than a byte order mark; x-user-defined is Latin-1
	// for everything a page can render
	if (/^utf-?16/i.test(label) && !(bytes[0] === 0xfe || bytes[0] === 0xff))
		label = 'utf-8';
	if (/^x-user-defined$/i.test(label)) label = 'windows-1252';
	let decoder: TextDecoder;
	try {
		decoder = new TextDecoder(label);
	} catch (error) {
		decoder = new TextDecoder('utf-8');
	}
	return decoder.decode(bytes);
}

/** the Content-Type header for the rewritten, UTF-8 document */
export function utf8ContentType(contentType: string | null): string {
	const mime = (contentType || 'text/html').split(';')[0].trim() || 'text/html';
	return `${mime}; charset=utf-8`;
}

/**
 * The encoding Chrome decodes a script's response with: a byte order mark,
 * (UTF-8 only, for a module), then the Content-Type charset (a label
 * TextDecoder does not know is ignored; for a module only one that names
 * windows-1252, which latin1, iso-8859-1 and us-ascii do too: Chrome 152
 * and 157 read a module served as windows-1250 or shift_jis as UTF-8),
 * else UTF-8 (measured for classic and module scripts of an element and a
 * dedicated worker's script, script-charset suite). A
 * classic script with neither would take its element's charset attribute or
 * the document's encoding, which is UTF-8 for every proxied document.
 */
export function scriptEncoding(
	bytes: Uint8Array,
	contentType: string | null,
	module: boolean,
): string {
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xef &&
		bytes[1] === 0xbb &&
		bytes[2] === 0xbf
	)
		return 'utf-8';
	// a module is not decoded by a UTF-16 byte order mark (it fails to
	// parse, natively too)
	if (!module && bytes.length >= 2) {
		if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
		if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
	}
	const label = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType || '')?.[1];
	if (label)
		try {
			const encoding = new TextDecoder(label).encoding;
			if (!module || encoding === 'windows-1252') return encoding;
		} catch {
			// not an encoding: as if none were named
		}
	return 'utf-8';
}

/** a script as text, decoded as the browser would have (scriptEncoding) */
export function decodeScript(
	bytes: Uint8Array,
	contentType: string | null,
	module: boolean,
): string {
	return new TextDecoder(scriptEncoding(bytes, contentType, module)).decode(
		bytes,
	);
}
