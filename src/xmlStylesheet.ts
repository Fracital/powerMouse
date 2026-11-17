// The pseudo-attributes of an xml-stylesheet processing instruction, read
// the way Blink reads them (ProcessingInstruction::CheckStyleSheet): XML
// attribute syntax, entities decoded, anything malformed reads as no
// stylesheet at all. Shared by the inject (a PI a page inserts, an XML
// document's prolog) and the worker (whether an XML document is styled by
// an XSLT).

/** the `type` values Blink applies as an XSLT; an absent or text/css type is CSS */
const XSL_TYPES = [
	'text/xml',
	'text/xsl',
	'application/xml',
	'application/xhtml+xml',
	'application/rss+xml',
	'application/atom+xml',
];

const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
};

function decode(value: string): string {
	return value.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, name: string) => {
		if (name[0] !== '#') return ENTITIES[name] ?? whole;
		const code =
			name[1] === 'x' || name[1] === 'X'
				? parseInt(name.slice(2), 16)
				: parseInt(name.slice(1), 10);
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
	});
}

export interface PseudoAttribute {
	value: string;
	/** where the quoted value starts and ends in the data (the quotes excluded) */
	start: number;
	end: number;
}

/** the data's pseudo-attributes, or null when they do not parse as XML attributes */
export function pseudoAttributes(
	data: string,
): Map<string, PseudoAttribute> | null {
	const attributes = new Map<string, PseudoAttribute>();
	const attribute = /\s*([^\s=<>"'/]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
	let at = 0;
	while (at < data.length) {
		if (/^\s*$/.test(data.slice(at))) break;
		attribute.lastIndex = at;
		const match = attribute.exec(data);
		// attributes are separated by whitespace
		if (!match || (at > 0 && !/\s/.test(data[at]))) return null;
		const raw = match[2] ?? match[3];
		const end = attribute.lastIndex - 1;
		if (attributes.has(match[1])) return null;
		attributes.set(match[1], {
			value: decode(raw),
			start: end - raw.length,
			end,
		});
		at = attribute.lastIndex;
	}
	return attributes;
}

/** what an xml-stylesheet PI with this data loads: a CSS sheet, an XSLT, or nothing */
export function stylesheetKind(data: string): 'css' | 'xsl' | null {
	const attributes = pseudoAttributes(data);
	if (!attributes) return null;
	const type = attributes.get('type')?.value ?? '';
	const kind =
		type === '' || type === 'text/css'
			? 'css'
			: XSL_TYPES.includes(type)
				? 'xsl'
				: null;
	if (!kind) return null;
	// an alternate sheet with no title is no sheet
	if (
		attributes.get('alternate')?.value === 'yes' &&
		!attributes.get('title')?.value
	)
		return null;
	return attributes.has('href') ? kind : null;
}

/** the data with its href replaced by `map`'s answer (escaped for its quotes), or null when it has none */
export function mapStylesheetHref(
	data: string,
	map: (href: string) => string | null,
): string | null {
	const href = pseudoAttributes(data)?.get('href');
	if (!href) return null;
	const mapped = map(href.value);
	if (mapped === null) return null;
	const escaped = mapped
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
	return data.slice(0, href.start) + escaped + data.slice(href.end);
}
