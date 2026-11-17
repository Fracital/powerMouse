// Byte strings: a header's bytes as JS has them, one character a byte
// (U+0000 to U+00FF), the way a browser exposes a header value and the
// transport hands one over.

/** whether `text` has a character past ASCII */
export const pastASCII = (text: string) => /[\u0080-\uffff]/.test(text);

/**
 * A byte string read as UTF-8, or null when its bytes are not UTF-8. escape
 * writes each byte as %XX, which decodeURIComponent reads as UTF-8 and
 * refuses when it is not (and a character past U+00FF, no byte at all, as
 * %uXXXX).
 */
export function utf8Text(bytes: string): string | null {
	try {
		return decodeURIComponent(escape(bytes));
	} catch (error) {
		return null;
	}
}

let encoder: TextEncoder | undefined;

/** `text` as its UTF-8 bytes, a character each (a lone surrogate as U+FFFD's) */
export function utf8Bytes(text: string): string {
	encoder ??= new TextEncoder();
	let bytes = '';
	for (const byte of encoder.encode(text)) bytes += String.fromCharCode(byte);
	return bytes;
}
