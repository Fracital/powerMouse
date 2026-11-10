// How an XMLHttpRequest turns its bytes into text, as the XHR standard says:
// the charset of overrideMimeType() wins over the response's Content-Type
// charset, a byte order mark wins over both, with neither an XML response
// under the default type ('', not 'text') is read in the encoding its XML
// declaration names, and otherwise the text is UTF-8. A page reading binary through responseText relies on this: it
// overrides the type with `charset=x-user-defined`, which maps every byte
// past 0x7F to U+F780..U+F7FF so `charCodeAt(i) & 0xff` gives the byte back.

// taken when the bundle loads, before page code can replace it
const NativeTextDecoder = TextDecoder;

export interface MimeType {
	essence: string;
	charset: string | null;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/;

/** a MIME type string's essence and charset, null when it does not parse */
export function parseMime(value: string | null): MimeType | null {
	if (value === null) return null;
	const [type, ...params] = value.split(';');
	const essence = type.trim().toLowerCase();
	if (!TOKEN.test(essence)) return null;
	let charset: string | null = null;
	for (const param of params) {
		const eq = param.indexOf('=');
		if (eq < 0 || param.slice(0, eq).trim().toLowerCase() !== 'charset')
			continue;
		charset =
			param
				.slice(eq + 1)
				.trim()
				.replace(/^"(.*)"$/, '$1') || null;
		break;
	}
	return { essence, charset };
}

/** what overrideMimeType keeps for `value` (an invalid type is octet-stream) */
export function overrideMime(value: unknown): MimeType {
	return (
		parseMime(String(value)) ?? {
			essence: 'application/octet-stream',
			charset: null,
		}
	);
}

/**
 * The response's final MIME type: the override's essence when there is one,
 * and the override's charset, else the response's
 */
export function finalMime(
	override: MimeType | null,
	contentType: string | null,
): MimeType {
	const response = parseMime(contentType);
	return {
		essence: override?.essence ?? response?.essence ?? '',
		charset: override?.charset ?? response?.charset ?? null,
	};
}

/** whether a MIME type essence is an XML one (text/xml, application/xml, +xml) */
export function isXMLType(essence: string): boolean {
	return /^(text|application)\/xml$/.test(essence) || /\+xml$/.test(essence);
}

const XML_DECLARATION =
	/^<\?xml\s+version\s*=\s*(["'])[^"']*\1\s+encoding\s*=\s*(["'])([A-Za-z][\w.-]*)\2/;

/** the encoding an XML declaration at the start of `view` names, or null */
function declaredEncoding(view: Uint8Array): string | null {
	let head = '';
	for (let i = 0; i < view.length && i < 1024; i++)
		head += String.fromCharCode(view[i]);
	return XML_DECLARATION.exec(head)?.[3] ?? null;
}

/**
 * The response text for `bytes` under `charset`, as the browser decodes it;
 * `xml`: an XML response under the default type, whose declaration may name
 * the encoding
 */
export function decodeText(
	bytes: ArrayBuffer,
	charset: string | null,
	xml = false,
): string {
	const view = new Uint8Array(bytes);
	let label = charset ?? (xml ? declaredEncoding(view) : null) ?? 'utf-8';
	if (view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) label = 'utf-8';
	else if (view[0] === 0xfe && view[1] === 0xff) label = 'utf-16be';
	else if (view[0] === 0xff && view[1] === 0xfe) label = 'utf-16le';
	let decoder: TextDecoder;
	try {
		decoder = new NativeTextDecoder(label);
	} catch (error) {
		// a label the Encoding standard does not know means UTF-8
		decoder = new NativeTextDecoder('utf-8');
	}
	return decoder.decode(view);
}
