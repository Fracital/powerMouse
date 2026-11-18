// A refresh value's parse and its route (`<meta http-equiv=refresh>`, the
// `Refresh` header), apart from src/rewriteHTML.ts: the worker routes every
// Refresh header it serves, and in a page it is a deferred part
// (src/inject/dom/rareAttributes.ts), since few documents have a refresh
// meta.
import type { Config } from './config';
import { routeHTML } from './rewriteHTML';
import StompURL from './StompURL';

/**
 * The HTML spec's parse of a refresh value (`<meta http-equiv=refresh>`, the
 * `Refresh` header): whitespace, the time (digits, then anything up to the
 * separator), an optional `;` or `,`, whitespace, an optional `url`
 * (any case) with `=`, whitespace, then the URL, which drops a matching pair
 * of quotes around it. Null when there is no URL (a reload after `time`).
 */
export function parseRefresh(value: string): {
	time: string;
	url: string | null;
} {
	let i = 0;
	const space = () => {
		while (i < value.length && /[\t\n\f\r ]/.test(value[i])) i++;
	};
	space();
	const timeStart = i;
	while (i < value.length && /[0-9]/.test(value[i])) i++;
	// anything else before the separator belongs to the time (the browser
	// ignores it; "5.5" or "5abc" are both 5 seconds)
	while (i < value.length && !/[;,\t\n\f\r ]/.test(value[i])) i++;
	const time = value.slice(timeStart, i);
	space();
	if (i >= value.length) return { time, url: null };
	if (value[i] === ';' || value[i] === ',') i++;
	space();
	if (i >= value.length) return { time, url: null };
	if (/^url/i.test(value.slice(i, i + 3))) {
		let j = i + 3;
		while (j < value.length && /[\t\n\f\r ]/.test(value[j])) j++;
		if (value[j] === '=') {
			i = j + 1;
			space();
		}
		// `url` without `=`: the browser takes what follows as the URL
	}
	let url = value.slice(i);
	const quote = url[0];
	if (quote === '"' || quote === "'") {
		const close = url.indexOf(quote, 1);
		url = close === -1 ? url.slice(1) : url.slice(1, close);
	}
	// what the URL parser strips: C0 controls and space, not the Unicode
	// spaces String.prototype.trim drops too (a no-break space before
	// `javascript:` makes it a relative path, natively)
	url = url.replace(/^[\0-\x20]+|[\0-\x20]+$/g, '');
	return { time, url: url === '' ? null : url };
}

// excellent resource
// https://web.archive.org/web/20210514140514/https://www.otsukare.info/2015/03/26/refresh-http-header
export function modifyRefresh(
	script: string,
	url: StompURL,
	config: Config,
	nested: string | false = false,
) {
	const { time, url: target } = parseRefresh(script);
	if (target === null) return script;
	let resolved: URL;
	try {
		resolved = new URL(target, url.toString());
	} catch (error) {
		return script;
	}
	// a data: document is the page's markup like a frame's data: src, and
	// Chrome follows a refresh to one in a frame: routeHTML rewrites it, or
	// its scripts run raw. A javascript: refresh Chrome never follows.
	if (!/^(https?|data):$/.test(resolved.protocol)) return script;
	return `${time}; url=${routeHTML(
		new StompURL(resolved, url),
		url,
		config,
		false,
		nested,
	)}`;
}
