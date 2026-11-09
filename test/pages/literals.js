// Every kind of literal the rewriter reprints, as the page computes it: a
// value it can compare, in both a script the worker rewrites (this one) and
// an inline one the page's client rewrites (literals.html).
function literalFingerprints() {
	const k = 'key';
	const a = { key: 21n };
	const obj = {};
	// a BigInt the rewriter reuses inside its own call (a computed write, a
	// computed read times a BigInt)
	obj[k] = 9n;
	const reused = a[k] * 2n;
	const show = (v) =>
		typeof v === 'string'
			? `string ${[...v].map((c) => c.charCodeAt(0).toString(16)).join(',')}`
			: v instanceof RegExp
				? `regexp ${v.source} ${v.flags}`
				: `${typeof v} ${String(v)}`;
	return {
		zero: show(0n),
		hex: show(0x9e3779b185ebca87n),
		octal: show(0o17n),
		binary: show(0b101n),
		separated: show(1_000_000n),
		huge: show(123456789012345678901234567890n),
		product: show(0x9e3779b185ebca87n * 3n),
		typeofZero: typeof 0n,
		write: show(obj.key),
		read: show(reused),
		regexV: show(/[\p{L}--[a-z]]/v),
		regexD: show(/(?<n>a)/d),
		number: show(9007199254740993),
		small: show(5e-324),
		big: show(1.7976931348623157e308),
		surrogate: show('a\ud800b\udc00'),
		separators: show('  '),
	};
}
window.__external = literalFingerprints();
