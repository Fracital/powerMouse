// Match patterns (https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)
// and content-script globs, compiled once each. Ported from STicks
// (src/match.ts).

const SCHEMES = ['http', 'https', 'ws', 'wss', 'ftp', 'file'];

const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

const compiled = new Map<string, RegExp | null>();

/** a match pattern as a RegExp over `scheme://host[:port]/path?query`, null for an invalid one */
export function patternToRegExp(pattern: string): RegExp | null {
	const hit = compiled.get(pattern);
	if (hit !== undefined) return hit;
	let result: RegExp | null = null;
	if (pattern === '<all_urls>') result = /^(https?|wss?|ftp|file):\/\//;
	else {
		const parts = /^(\*|[a-z-]+):\/\/([^/]*)(\/.*)?$/.exec(pattern);
		if (parts && (parts[1] === '*' || SCHEMES.includes(parts[1]))) {
			const scheme = parts[1] === '*' ? 'https?|wss?' : escape(parts[1]);
			const host = parts[2];
			let hostRe: string;
			if (host === '*') hostRe = '[^/]*';
			else if (host.startsWith('*.'))
				hostRe = `(?:[^/]*\\.)?${escape(host.slice(2))}(?::\\d+)?`;
			else hostRe = `${escape(host)}(?::\\d+)?`;
			const path = (parts[3] ?? '/').split('*').map(escape).join('.*');
			result = new RegExp(`^(?:${scheme}):\\/\\/${hostRe}${path}$`);
		}
	}
	if (compiled.size > 4096) compiled.clear();
	compiled.set(pattern, result);
	return result;
}

/** the URL as match patterns read it: no fragment, no credentials */
function bare(url: string): string | null {
	try {
		const parsed = new URL(url);
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
	} catch (error) {
		return null;
	}
}

export function matchesPattern(pattern: string, url: string): boolean {
	const re = patternToRegExp(pattern);
	if (!re) return false;
	const text = bare(url);
	return text !== null && re.test(text);
}

export function matchesAny(patterns: string[] | undefined, url: string) {
	return !!patterns?.some((pattern) => matchesPattern(pattern, url));
}

const globs = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
	let re = globs.get(glob);
	if (!re) {
		re = new RegExp(
			`^${glob
				.split('')
				.map((char) =>
					char === '*' ? '.*' : char === '?' ? '.' : escape(char),
				)
				.join('')}$`,
		);
		globs.set(glob, re);
	}
	return re;
}

export function matchesGlobs(
	include: string[] | undefined,
	exclude: string[] | undefined,
	url: string,
): boolean {
	if (include?.length && !include.some((glob) => globToRegExp(glob).test(url)))
		return false;
	return !exclude?.some((glob) => globToRegExp(glob).test(url));
}

/** whether a content-script registration runs on this URL */
export function scriptMatches(
	registration: {
		matches?: string[];
		exclude_matches?: string[];
		include_globs?: string[];
		exclude_globs?: string[];
	},
	url: string,
): boolean {
	return (
		matchesAny(registration.matches, url) &&
		!matchesAny(registration.exclude_matches, url) &&
		matchesGlobs(registration.include_globs, registration.exclude_globs, url)
	);
}

/** whether granted host permissions cover `url` (`<all_urls>` and match patterns) */
export function hostPermitted(granted: Iterable<string>, url: string): boolean {
	for (const permission of granted)
		if (
			(permission === '<all_urls>' || permission.includes('://')) &&
			matchesPattern(permission, url)
		)
			return true;
	return false;
}
