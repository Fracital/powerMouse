import GenericCodec from './Codecs';
import { fragmentOf, queryOf } from './urlShape';

export declare type urlLike = URL | string;

export function isUrlLike(object: unknown): object is urlLike {
	return (
		typeof object === 'string' ||
		(typeof object === 'object' && object instanceof URL)
	);
}

/**
 * A document's fragment as its route holds it: `~` and the seal, or nothing
 * for an empty one. The mark tells it from a fragment the browser commits
 * as written for a moment (the inject's Fragment module), which a short one
 * could otherwise be read as a seal.
 */
export function sealFragmentText(
	codec: GenericCodec,
	fragment: string,
	stable = false,
): string {
	if (!fragment) return '';
	return `~${stable ? codec.encodeStable(fragment) : codec.encode(fragment)}`;
}

/**
 * A document route's fragment as the page wrote it: the text the seal
 * holds, or the fragment itself when it holds none (a route from before
 * fragments were sealed, the browser's own fragment navigation)
 */
export function openFragment(codec: GenericCodec, fragment: string): string {
	return sealedFragmentText(codec, fragment) ?? fragment;
}

/** the text a sealed fragment (without its `#`) holds, or null for one that is not sealed (StompURL's sealFragmentText) */
export function sealedFragmentText(
	codec: GenericCodec,
	fragment: string,
): string | null {
	if (!fragment.startsWith('~') || fragment.length < 2) return null;
	try {
		return codec.decode(fragment.slice(1)) || null;
	} catch (error) {
		return null;
	}
}

export default class StompURL {
	codec: GenericCodec;
	directory: string;
	url: URL;
	constructor(url: urlLike, reference: StompURL);
	constructor(url: urlLike, codec: GenericCodec, directory: string);

	constructor(
		url: urlLike,
		codec: GenericCodec | StompURL,
		directory?: string,
	) {
		if (codec instanceof StompURL) {
			const copy = codec;
			codec = copy.codec;
			directory = copy.directory;
		}

		if (isUrlLike(url)) {
			this.url = new URL(url);
		} else {
			throw new TypeError('Unknown overload');
		}

		if (typeof directory !== 'string') {
			throw new TypeError(`Directory wasn't string`);
		}

		this.codec = codec;
		this.directory = directory;
	}
	/**
	 * The route's last segment: the URL without its fragment, sealed, and
	 * the fragment after it, an empty query or fragment kept
	 * (src/urlShape.ts). A document's fragment is sealed too
	 * (`sealFragment`, docs/codec.md); a subresource's stays as written,
	 * since the browser reads it there (an SVG sprite's `#icon`, a filter's
	 * `url(#blur)`), and it is never sent.
	 */
	encode(sealFragment = false) {
		const body = this.codec.encode(
			this.url.origin + this.url.pathname + queryOf(this.url),
		);
		const fragment = fragmentOf(this.url);
		if (!fragment) return body;
		const text = fragment.slice(1);
		return `${body}#${sealFragment ? sealFragmentText(this.codec, text) : text}`;
	}
	toString() {
		return this.url.toString();
	}
}
