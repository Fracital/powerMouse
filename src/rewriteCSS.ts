import { generate, parse, Url, walk } from 'css-tree';
import { createDataURI, parseDataURI, routeBinary, routeURL } from './routeURL';
import StompURL from './StompURL';

export function routeCSS(resource: StompURL, url: StompURL) {
	if (resource.url.protocol === 'data:') {
		const { mime, data, attributes } = parseDataURI(resource.url.pathname);
		return createDataURI({
			mime,
			data: modifyCSS(data, url),
			attributes,
		});
	}

	return routeURL('css', resource);
}

function preserveValue(url: string, value: string) {
	{
		const hashi = url.indexOf('#');
		if (hashi !== -1) {
			url = url.slice(0, hashi);
		}
	}

	return `${url}#${value}`;
}

function restoreValue(url: string) {
	const hashi = url.indexOf('#');

	if (hashi === -1) {
		throw new Error('Invalid value URL');
	}

	return url.slice(hashi + 1);
}

const RAW_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/g;

/**
 * The page's URL from a value that may already be routed: a routed url()
 * keeps the original token after '#', which the browser serialises with
 * percent-encoded quotes. Rewriting is idempotent because of this, so text
 * rewritten before parsing and rules rewritten again in the CSSOM agree.
 */
function originalOf(target: string): string {
	const hash = target.indexOf('#url(');
	if (hash === -1) return target;
	let token = target.slice(hash + 1);
	try {
		token = decodeURIComponent(token);
	} catch (error) {
		// not percent-encoded
	}
	const match = /^url\(\s*(['"]?)(.*?)\1\s*\)$/s.exec(token);
	return match ? match[2] : target;
}

/**
 * Route every url() in a raw CSS value (a single declaration value, a custom
 * property, or anything css-tree can't parse) through the binary route.
 */
export function rewriteCSSValueURLs(value: string, url: StompURL): string {
	return value.replace(RAW_URL, (match, quote, target) => {
		try {
			const original = originalOf(target);
			const resolved = new StompURL(new URL(original, url.toString()), url);
			if (original !== target) match = `url(${JSON.stringify(original)})`;
			// keep the page's own token after '#', so reads can give it back
			return `url(${JSON.stringify(
				preserveValue(routeBinary(resolved), match),
			)})`;
		} catch (error) {
			return match;
		}
	});
}

/** inverse of rewriteCSSValueURLs for values the page reads back */
export function restoreCSSValueURLs(value: string): string {
	return value.replace(RAW_URL, (match, quote, target) => {
		try {
			return restoreValue(target);
		} catch (error) {
			return match;
		}
	});
}

export function modifyCSS(
	script: string,
	url: StompURL,
	context = 'stylesheet',
) {
	const tree = parse(script, { positions: true, context });
	let offset = 0;

	walk(tree, function (node) {
		// css-tree leaves custom property values (--x: url(...)) unparsed
		if (node.type === 'Raw' && this.declaration?.property.startsWith('--')) {
			const generated = rewriteCSSValueURLs(node.value, url);

			if (generated !== node.value) {
				script =
					script.slice(0, node.loc!.start.offset - offset) +
					generated +
					script.slice(node.loc!.end.offset - offset);
				offset +=
					node.loc!.end.offset - node.loc!.start.offset - generated.length;
			}
		} else if (node.type === 'String' && this.atrule?.name === 'import') {
			try {
				// already routed (a second pass over rewritten text): leave it
				if (node.value.startsWith(`${url.directory}css/`)) return;
				const resolved = new StompURL(new URL(node.value, url.toString()), url);
				const generated = JSON.stringify(routeCSS(resolved, url));

				script =
					script.slice(0, node.loc!.start.offset - offset) +
					generated +
					script.slice(node.loc!.end.offset - offset);
				offset +=
					node.loc!.end.offset - node.loc!.start.offset - generated.length;
			} catch (error) {
				console.error(error);
			}
		} else if (node.type === 'Url')
			try {
				const original = originalOf(node.value);
				// @ts-ignore
				const resolved = new StompURL(new URL(original, url), url);

				let replace: Url;

				const raw =
					original === node.value
						? script.slice(
								node.loc!.start.offset - offset,
								node.loc!.end.offset - offset,
							)
						: `url(${JSON.stringify(original)})`;

				if (this.atrule?.name === 'import') {
					replace = {
						type: 'Url',
						value: preserveValue(routeCSS(resolved, url), raw),
					};
				} else {
					replace = {
						type: 'Url',
						value: preserveValue(routeBinary(resolved), raw),
					};
				}

				const generated = generate(replace);

				script =
					script.slice(0, node.loc!.start.offset - offset) +
					generated +
					script.slice(node.loc!.end.offset - offset);
				offset +=
					node.loc!.end.offset - node.loc!.start.offset - generated.length;
			} catch (error) {
				console.error(error);
			}
	});

	return script;
}

export function restoreCSS(script: string, url: StompURL, context: string) {
	const tree = parse(script, {
		positions: true,
		context,
	});
	let offset = 0;

	walk(tree, function (node) {
		if (node.type === 'Url') {
			// @ts-ignore
			const generated = restoreValue(node.value);

			script =
				script.slice(0, node.loc!.start.offset - offset) +
				generated +
				script.slice(node.loc!.end.offset - offset);
			offset +=
				node.loc!.end.offset - node.loc!.start.offset - generated.length;
		}
	});

	return script;
}
