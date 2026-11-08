// Base64 for the synchronous bridge's bodies, written out rather than taken
// from atob/btoa: the inject bundle runs next to page code, which may have
// replaced those globals, and the service worker shares the module.

const ALPHABET =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUES = new Uint8Array(128);
for (let i = 0; i < ALPHABET.length; i++) VALUES[ALPHABET.charCodeAt(i)] = i;

export function encodeBase64(bytes: Uint8Array): string {
	let result = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const a = bytes[i];
		const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
		const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
		result +=
			ALPHABET[a >> 2] +
			ALPHABET[((a & 3) << 4) | (b >> 4)] +
			(i + 1 < bytes.length ? ALPHABET[((b & 15) << 2) | (c >> 6)] : '=') +
			(i + 2 < bytes.length ? ALPHABET[c & 63] : '=');
	}
	return result;
}

export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
	let end = text.length;
	while (end > 0 && text[end - 1] === '=') end--;
	const bytes = new Uint8Array(Math.floor((end * 3) / 4));
	let at = 0;
	for (let i = 0; i < end; i += 4) {
		const a = VALUES[text.charCodeAt(i)];
		const b = VALUES[text.charCodeAt(i + 1)];
		const c = VALUES[text.charCodeAt(i + 2)];
		const d = VALUES[text.charCodeAt(i + 3)];
		bytes[at++] = (a << 2) | (b >> 4);
		if (i + 2 < end) bytes[at++] = ((b & 15) << 4) | (c >> 2);
		if (i + 3 < end) bytes[at++] = ((c & 3) << 6) | d;
	}
	return bytes;
}
