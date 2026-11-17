// A srcset attribute's image candidates, read and written as the `srcset`
// package (5.0) does with its default options: the same regular expression,
// the same replacements (only the first line break and the first comma before
// whitespace) and descriptors read with parseFloat. The package's strict mode
// is never asked for, but its validators (most of its bytes) were in the
// document bundle, which every proxied frame evaluates: both functions name
// them, so the bundler could not leave them out.
//
// Adapted from srcset 5.0.3, MIT License, Copyright (c) Sindre Sorhus
// <sindresorhus@gmail.com> (https://sindresorhus.com).

export interface SrcSetDefinition {
	url: string;
	width?: number;
	height?: number;
	density?: number;
}

/** an "image candidate string", loosely: what the package splits on */
const imageCandidate = /\s*([^,]\S*[^,](?:\s+[^,]+)?)\s*(?:,|$)/;

export function parseSrcset(srcset: string): SrcSetDefinition[] {
	return srcset
		.replace(/\r?\n/, '')
		.replace(/,\s+/, ', ')
		.split(imageCandidate)
		.filter((part, index) => index % 2 === 1)
		.map((part) => {
			const [url, ...descriptors] = part.trim().split(/\s+/);
			const result: SrcSetDefinition = { url };
			for (const descriptor of descriptors) {
				const postfix = descriptor[descriptor.length - 1];
				const value = Number.parseFloat(descriptor.slice(0, -1));
				if (postfix === 'w') result.width = value;
				else if (postfix === 'h') result.height = value;
				else if (postfix === 'x') result.density = value;
			}
			return result;
		});
}

const POSTFIXES: Record<string, string> = {
	width: 'w',
	height: 'h',
	density: 'x',
};

export function stringifySrcset(
	definitions: readonly SrcSetDefinition[],
): string {
	return definitions
		.map((definition) => {
			if (!definition.url) return '';
			const result = [definition.url];
			for (const key of Object.keys(definition))
				if (Object.hasOwn(POSTFIXES, key))
					result.push(
						`${definition[key as keyof SrcSetDefinition]}${POSTFIXES[key]}`,
					);
			return result.join(' ');
		})
		.join(', ');
}
