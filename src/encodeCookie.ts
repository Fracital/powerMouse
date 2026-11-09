// https://stackoverflow.com/a/45536811

const validChars =
	"abdefghijklmnqrstuvxyzABDEFGHIJKLMNQRSTUVXYZ0123456789!#$%&'()*+-./:<>?@[]^_`{|}~";
const reserveChar = '%';

export function validCookie(cookie: string): boolean {
	for (let i = 0; i < cookie.length; i++) {
		const char = cookie[i];

		if (!validChars.includes(char)) {
			return false;
		}
	}

	return true;
}

export function encodeCookie(cookie: string): string {
	let result = '';

	for (let i = 0; i < cookie.length; i++) {
		const char = cookie[i];

		if (validChars.includes(char) && char !== reserveChar) {
			result += char;
		} else {
			const code = char.charCodeAt(0);
			// a code unit past U+00FF (UTF-8 text, U+FFFD) needs four digits; `u`
			// is no hex digit, so the two forms cannot be confused
			result +=
				code > 0xff
					? reserveChar + 'u' + code.toString(16).padStart(4, '0')
					: reserveChar + code.toString(16).padStart(2, '0');
		}
	}

	return result;
}

export function decodeCookie(cookie: string): string {
	let result = '';

	for (let i = 0; i < cookie.length; i++) {
		const char = cookie[i];

		if (char === reserveChar && cookie[i + 1] === 'u') {
			result += String.fromCharCode(parseInt(cookie.slice(i + 2, i + 6), 16));
			i += 5;
		} else if (char === reserveChar) {
			const code = parseInt(cookie.slice(i + 1, i + 3), 16);
			const decoded = String.fromCharCode(code);

			result += decoded;
			i += 2;
		} else {
			result += char;
		}
	}

	return result;
}

/** the most of an encoded answer one sync bridge cookie carries */
export const SYNC_CHUNK = 4000;

/**
 * The cookies that carry the service worker's answer to a synchronous
 * request, in the order to set them: the chunks, then the main cookie named
 * `id`, whose value is the number of chunks and the first piece, so a page
 * that sees it sees the whole answer. The count is that of the chunks left
 * once the first piece is cut (room is kept for a five-digit count); counted
 * from the whole length, it came out one short when the answer ran a
 * character or two past a multiple of the chunk size, and the page decoded a
 * cut answer ("Bad control character in string literal in JSON").
 */
export function splitAnswer(id: string, encoded: string): [string, string][] {
	const head = encoded.slice(0, SYNC_CHUNK - 6);
	const rest = encoded.slice(head.length);
	const count = Math.ceil(rest.length / SYNC_CHUNK);
	const cookies: [string, string][] = [];
	for (let i = 0; i < count; i++)
		cookies.push([
			`${id}${i}`,
			rest.slice(i * SYNC_CHUNK, (i + 1) * SYNC_CHUNK),
		]);
	cookies.push([id, `${count},${head}`]);
	return cookies;
}

/**
 * The answer `splitAnswer` left in `cookies` (a `document.cookie` string) and
 * the names of the cookies that carried it, or null while it is not all there.
 */
export function joinAnswer(
	cookies: string,
	id: string,
): { value: string; names: string[] } | null {
	const main = new RegExp(`(?:^|; )${id}=(\\d+),([^;]*)`).exec(cookies);
	if (!main) return null;
	const names = [id];
	let value = main[2];
	for (let i = 0; i < Number(main[1]); i++) {
		const chunk = new RegExp(`(?:^|; )${id}${i}=([^;]*)`).exec(cookies);
		if (!chunk) return null;
		names.push(`${id}${i}`);
		value += chunk[1];
	}
	return { value, names };
}
