// Decoding a document's bytes the way the browser would have, before the
// rewriter sees it. The order is the HTML standard's: a byte order mark, then
// the Content-Type charset, then a prescan of the first 1024 bytes for
// `<meta charset>` or `<meta http-equiv="content-type">`, then UTF-8. The
// shell of an HTML document goes out in the encoding the document was
// decoded with (documentContentType, encodeShell): the browser gives the
// document that encoding, which is what it encodes the query of an
// element's URL and a form's submission with, and what
// document.characterSet reads.

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
	// a charset attribute's whole value is the label (`iso-8859-8 visual`
	// names no encoding, where its first word would)
	const metaCharset =
		/<meta[^>]*?\scharset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(
			head,
		);
	if (metaCharset) return metaCharset[1] ?? metaCharset[2] ?? metaCharset[3];
	const metaContent =
		/<meta[^>]*?http-equiv\s*=\s*["']?content-type["']?[^>]*?content\s*=\s*["']?[^"'>]*?charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(
			head,
		);
	if (metaContent) return metaContent[1];
	const xml = /^<\?xml[^>]*?encoding\s*=\s*["']([a-z0-9_:.-]+)/i.exec(head);
	if (xml) return xml[1];
	return null;
}

/**
 * The encoding the document is decoded with, by its name in the Encoding
 * Standard (TextDecoder's `encoding`: `utf-8`, `shift_jis`, `utf-16le`)
 */
export function documentEncoding(
	bytes: Uint8Array,
	contentType: string | null,
): string {
	let label = (sniffCharset(bytes, contentType) || 'utf-8').trim();
	// the standard maps the UTF-16 labels to UTF-8 when they come from a
	// declaration rather than a byte order mark; x-user-defined is Latin-1
	// for everything a page can render
	if (/^utf-?16/i.test(label) && !(bytes[0] === 0xfe || bytes[0] === 0xff))
		label = 'utf-8';
	if (/^x-user-defined$/i.test(label)) label = 'windows-1252';
	try {
		return new TextDecoder(label).encoding;
	} catch (error) {
		return 'utf-8';
	}
}

/**
 * The encoding an XML document is decoded with (Chrome's, by measurement:
 * xml-encoding suite): a byte order mark, then the Content-Type charset,
 * then the XML declaration's, then UTF-8. A meta names nothing, and a
 * UTF-16 label in a document without a byte order mark reads as UTF-8, as
 * in HTML
 */
export function xmlEncoding(
	bytes: Uint8Array,
	contentType: string | null,
): string {
	const bom = bomEncoding(bytes);
	if (bom) return bom;
	let head = '';
	const end = Math.min(bytes.length, PRESCAN_BYTES);
	for (let i = 0; i < end; i++) head += String.fromCharCode(bytes[i]);
	const encoding =
		labelEncoding(
			/;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType || '')?.[1],
		) ??
		labelEncoding(
			/^<\?xml[^>]*?encoding\s*=\s*["']([a-z0-9_:.-]+)/i.exec(head)?.[1],
		) ??
		'utf-8';
	if (encoding === 'utf-16le' || encoding === 'utf-16be') return 'utf-8';
	if (encoding === 'x-user-defined') return 'windows-1252';
	return encoding;
}

/** the document as text, decoded with the charset it declares */
export function decodeDocument(
	bytes: Uint8Array,
	contentType: string | null,
	encoding = documentEncoding(bytes, contentType),
): string {
	return new TextDecoder(encoding).decode(bytes);
}

/** the Content-Type header for the rewritten, UTF-8 document */
export function utf8ContentType(contentType: string | null): string {
	return documentContentType(contentType, 'utf-8');
}

/** the Content-Type header for a rewritten document served in `encoding` (encodeShell) */
export function documentContentType(
	contentType: string | null,
	encoding: string,
): string {
	const mime = (contentType || 'text/html').split(';')[0].trim() || 'text/html';
	return `${mime}; charset=${encoding}`;
}

const UTF8 = new TextEncoder();

/**
 * An HTML shell (src/rewriteHTML.ts) as the bytes the browser decodes back
 * to the same text in `encoding`, which the response names. UTF-8 and the
 * UTF-16 pair are written as they are. Any other encoding of the standard
 * reads ASCII bytes as ASCII (ISO-2022-JP too, from its initial state, so
 * long as no escape byte comes, and JSON escapes every control character),
 * so the shell goes out as ASCII: whatever is not ASCII in it is in a
 * script's string literal (the page's markup, its prewritten scripts and
 * the shell's other JSON; the tags and their URLs are ASCII), where a
 * `\uXXXX` escape of each UTF-16 unit is the same string. No encoder of the
 * document's own encoding is needed, and a lone surrogate the markup held
 * survives as it is.
 */
export function encodeShell(
	text: string,
	encoding: string,
): Uint8Array<ArrayBuffer> {
	if (encoding === 'utf-16le' || encoding === 'utf-16be') {
		const bytes = new Uint8Array(text.length * 2);
		const little = encoding === 'utf-16le';
		for (let i = 0; i < text.length; i++) {
			const unit = text.charCodeAt(i);
			bytes[i * 2 + (little ? 0 : 1)] = unit & 0xff;
			bytes[i * 2 + (little ? 1 : 0)] = unit >> 8;
		}
		return bytes;
	}
	if (encoding !== 'utf-8')
		text = text.replace(
			/[^\0-\x7f]/g,
			(unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`,
		);
	return UTF8.encode(text);
}

/**
 * Whether a module script served as windows-1252 (or a label naming it:
 * latin1, iso-8859-1, us-ascii) is decoded so. Chrome 152 and 157 do, and
 * 159 reads it as UTF-8 (script-charset suite, which compares with the
 * browser it runs in: CI's Chrome is 157, devbox's 159). Read once as this
 * file loads, from the browser's own version (the brands of userAgentData
 * first), before any page's configured identity could stand in for it.
 */
const MODULE_TAKES_1252 = (() => {
	const nav = (
		globalThis as {
			navigator?: {
				userAgent?: string;
				userAgentData?: { brands?: { brand: string; version: string }[] };
			};
		}
	).navigator;
	const brand = nav?.userAgentData?.brands?.find(
		({ brand }) => brand === 'Chromium' || brand === 'Google Chrome',
	);
	const major = Number(
		brand?.version ?? /\bChrome\/(\d+)/.exec(nav?.userAgent ?? '')?.[1],
	);
	return !(major >= 159);
})();

/**
 * The encoding Chrome decodes a script's response with: a byte order mark
 * (UTF-8 only, for a module), then the Content-Type charset (a label
 * TextDecoder does not know is ignored; for a module only windows-1252 and
 * the labels that name it, and only before Chrome 159 (MODULE_TAKES_1252):
 * every version measured reads windows-1250 or shift_jis as UTF-8), else
 * UTF-8 (measured for classic
 * and module scripts of an element and a dedicated worker's script,
 * script-charset suite). A classic script of a document with neither takes
 * the document's encoding (`environment`, src/server/documentEncodings.ts;
 * its element's charset attribute, which would come first, is not known
 * here).
 */
export function scriptEncoding(
	bytes: Uint8Array,
	contentType: string | null,
	module: boolean,
	environment = 'utf-8',
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
			if (!module || (MODULE_TAKES_1252 && encoding === 'windows-1252'))
				return encoding;
		} catch {
			// not an encoding: as if none were named
		}
	return module ? 'utf-8' : environment;
}

/** a script as text, decoded as the browser would have (scriptEncoding) */
export function decodeScript(
	bytes: Uint8Array,
	contentType: string | null,
	module: boolean,
	environment?: string,
): string {
	return new TextDecoder(
		scriptEncoding(bytes, contentType, module, environment),
	).decode(bytes);
}

/** the encoding a byte order mark names, or null without one */
function bomEncoding(bytes: Uint8Array): string | null {
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
	return null;
}

/** the encoding a label names (TextDecoder's), or null for none */
function labelEncoding(label: string | undefined): string | null {
	if (!label) return null;
	try {
		return new TextDecoder(label).encoding;
	} catch {
		return null;
	}
}

/** `@charset "` as bytes: the rule counts only written exactly so, first */
const CHARSET_RULE = [
	0x40, 0x63, 0x68, 0x61, 0x72, 0x73, 0x65, 0x74, 0x20, 0x22,
];

/**
 * The encoding a stylesheet is decoded with (CSS Syntax, "determine the
 * fallback encoding", after the byte order mark): the Content-Type charset,
 * then an `@charset "<label>";` the sheet starts with (a UTF-16 one reads as
 * UTF-8), then `environment` (its document's encoding), then UTF-8
 */
export function stylesheetEncoding(
	bytes: Uint8Array,
	contentType: string | null,
	environment = 'utf-8',
): string {
	const bom = bomEncoding(bytes);
	if (bom) return bom;
	const header = labelEncoding(
		/;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType || '')?.[1],
	);
	if (header) return header;
	if (CHARSET_RULE.every((byte, i) => bytes[i] === byte)) {
		let label = '';
		for (let i = CHARSET_RULE.length; i < Math.min(bytes.length, 1024); i++) {
			if (bytes[i] === 0x22) {
				if (bytes[i + 1] !== 0x3b) break;
				const encoding = labelEncoding(label);
				if (encoding === 'utf-16le' || encoding === 'utf-16be') return 'utf-8';
				if (encoding) return encoding;
				break;
			}
			label += String.fromCharCode(bytes[i]);
		}
	}
	return environment;
}
