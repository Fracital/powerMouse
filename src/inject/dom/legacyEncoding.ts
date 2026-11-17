// What a document in a legacy encoding needs to encode a URL's query and a
// form's submission in it (DocumentClient.encodingParse, the FormQuery
// module): a deferred part (./deferredParts.ts), evaluated only once a page
// in such an encoding routes a URL or submits a form with text that the
// encoding writes otherwise than UTF-8. The encoder itself is the browser's,
// a link of the document (DocumentClient.legacyEncoder).

/** the document's legacy encoding and the browser's encoder for it */
export interface LegacyEncoder {
	/** the encoding, by Chrome's name for it (`Shift_JIS`) */
	encoding: string;
	/**
	 * `text` percent-encoded as the URL parser encodes a special URL's
	 * query in the encoding (a character it lacks as `%26%23<code
	 * point>%3B`); a `#` ends it and ASCII tabs and newlines go, as the
	 * parser has them. `fragment`: the query is not the input's end (its
	 * trailing spaces stay)
	 */
	encode: (text: string, fragment: boolean) => string;
}

/** whether `text` holds a byte ISO-2022-JP cannot encode as itself (SO, SI, ESC) */
const hasISO2022Escape = (text: string) =>
	text.includes('\u000e') || text.includes('\u000f') || text.includes('\u001b');

/** whether `text` encodes otherwise in `encoding` than in UTF-8 (what is not ASCII, and ISO-2022-JP's three escape bytes, which it lacks) */
const legacyText = (text: string, encoding: string): boolean =>
	/[^\0-\x7f]/.test(text) ||
	(encoding === 'ISO-2022-JP' && hasISO2022Escape(text));

/**
 * `input` with its query (from the first `?` to the fragment, if no `#`
 * came first) percent-encoded in the document's encoding, or null when
 * that writes nothing otherwise than UTF-8
 */
export function legacyQuery(
	input: string,
	encoder: LegacyEncoder,
): string | null {
	const start = input.indexOf('?');
	const hash = input.indexOf('#');
	if (start === -1 || (hash !== -1 && hash < start)) return null;
	const end = hash === -1 ? input.length : hash;
	const query = input.slice(start + 1, end);
	if (!legacyText(query, encoder.encoding)) return null;
	return (
		input.slice(0, start + 1) +
		encoder.encode(query, hash !== -1) +
		input.slice(end)
	);
}

/**
 * Which encoding a form's submission is in: the first encoding its
 * accept-charset names (split at spaces and commas), else the document's
 * (Chrome 157, measured: an accept-charset that names none is the
 * document's, where the HTML standard has UTF-8); `document` when that is
 * the document's legacy one (legacyFormQuery), `other` for another legacy
 * one
 */
export function formEncoding(
	acceptCharset: string | null,
	encoder: LegacyEncoder | null,
): 'utf-8' | 'document' | 'other' {
	let named = encoder?.encoding ?? 'utf-8';
	if (acceptCharset !== null)
		for (const label of acceptCharset.split(/[\t\n\f\r ,]+/)) {
			if (!label) continue;
			try {
				// (the realm's own TextDecoder: a page that replaced it misnames
				// only its own form's encoding)
				named = new globalThis.TextDecoder(label).encoding;
				break;
			} catch {
				// not an encoding: the next
			}
		}
	if (/^(utf-8|utf-16(le|be))$/i.test(named)) return 'utf-8';
	return named.toLowerCase() === encoder?.encoding.toLowerCase()
		? 'document'
		: 'other';
}

/**
 * A GET form's entries as the browser's application/x-www-form-urlencoded
 * serializer writes them in the document's legacy encoding (formEncoding)
 */
export function legacyFormQuery(
	entries: [string, string][],
	encoder: LegacyEncoder,
): string {
	const component = (text: string): string => {
		let bytes = text;
		if (legacyText(text, encoder.encoding)) {
			// every character the parser would not hand on as it is (a `%`, a
			// `#`, a tab or newline) goes in escaped; the rest come back
			// percent-encoded or as they are, and are read back as bytes
			const encoded = encoder.encode(
				text.replace(
					/[%#\t\n\r]/g,
					(char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
				),
				true,
			);
			bytes = encoded.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) =>
				String.fromCharCode(parseInt(hex, 16)),
			);
		}
		let out = '';
		for (let i = 0; i < bytes.length; i++) {
			const byte = bytes.charCodeAt(i);
			out +=
				byte === 0x20
					? '+'
					: /[A-Za-z0-9*\-._]/.test(bytes[i])
						? bytes[i]
						: `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
		}
		return out;
	};
	return entries
		.map(([name, value]) => `${component(name)}=${component(value)}`)
		.join('&');
}
