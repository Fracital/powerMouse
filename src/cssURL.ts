// The CSSOM's serialization of a url() the page wrote, shared by the
// declaration readback (cssURLs) and the inject's (Unroute). It imports
// nothing: neither may bring the CSS parser into a frame or a worker.

/**
 * What a declaration value, an at-rule prelude or a selector must contain
 * for the walk to route anything in it: a url() token, a string inside
 * image-set() or src(), an @import's string, or a CSS escape (`\75 rl(` is
 * a url() token as well).
 */
export const MAY_ROUTE = /url\(|image-set|src\(|import|\\/i;

/** the contexts parsed lazily: values, preludes and selectors stay raw text */
export const LAZY_CONTEXTS = ['stylesheet', 'declarationList'];

/** CSSOM's serialization of a string: quoted, `"` and `\` escaped, controls as code points */
function serializeCSSString(value: string): string {
	let result = '"';
	for (const char of value) {
		const code = char.codePointAt(0)!;
		if (code === 0) result += '\uFFFD';
		else if ((code >= 0x1 && code <= 0x1f) || code === 0x7f)
			result += `\\${code.toString(16)} `;
		else if (char === '"' || char === '\\') result += `\\${char}`;
		else result += char;
	}
	return `${result}"`;
}

/**
 * A url() token the page wrote (`url(a.png)`, `url('a.png')`, ...) the way
 * the browser serializes the value it parsed from it: `url("a.png")`,
 * whatever quotes the page used. What does not look like a url() token is
 * given back as it is.
 */
export function serializeCSSURL(token: string): string {
	const match =
		/^url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^]*?))\s*\)$/i.exec(
			token,
		);
	if (!match) return token;
	const written = match[1] ?? match[2] ?? match[3];
	// a CSS escape stands for its character (a hex one for its code point)
	const value = written.replace(
		/\\(?:([0-9a-fA-F]{1,6})[ \t\n]?|([^]))/g,
		(_, hex?: string, char?: string) => {
			if (hex === undefined) return char ?? '';
			const code = Number.parseInt(hex, 16);
			return String.fromCodePoint(
				code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
					? 0xfffd
					: code,
			);
		},
	);
	return `url(${serializeCSSString(value)})`;
}
