import GenericCodec, { AESCodec, Base64Codec, XORCodec } from './Codecs';
import type { HelperNames } from './helperNames';

export declare type ConfigCodec = 'generic' | 'xor' | 'aes' | 'base64';

export interface Config {
	codec: ConfigCodec;
	/** pathname of the directory the service worker is scoped to, e.g. `/stomp/` */
	directory: string;
	/**
	 * Origins allowed to embed proxied documents, emitted as a
	 * `Content-Security-Policy: frame-ancestors` header. Set by the controller
	 * frame in origin-isolation mode so only the host application can frame
	 * the proxy origin. Absent in same-origin mode.
	 */
	frameAncestors?: string[];
	/**
	 * The host application handles `window.open` and `target="_blank"`
	 * (`onOpen` on the controller): pages post the URL to it instead of
	 * opening a popup, and `window.open` returns null like a popup blocker.
	 */
	openTab?: boolean;
	/**
	 * HTTP cache in the service worker, on unless `false`: GET/HEAD responses
	 * with explicit freshness are served from a Cache API store and
	 * revalidated with ETag / Last-Modified when stale.
	 */
	cache?: boolean;
	/** @internal the host wants a RequestInfo per request (ControllerInit.onRequest) */
	requestLog?: boolean;
	/**
	 * A script the rewriter cannot parse runs as it was (default). `false`
	 * makes it fail instead, with a SyntaxError naming the rewriter error, so
	 * a broken rewrite is loud while developing.
	 */
	allowInvalidJs?: boolean;
	/** @internal build id of the service worker that serves the page (src/version.ts) */
	build?: string;
	/** @internal ms a routed request may take before the service worker answers 504 (tests; default by destination) */
	fetchTimeout?: number;
	/** the served file names, when the host renamed them (see Assets) */
	assets?: Assets;
	/**
	 * The four global names the rewriter and the inject bundles use (see
	 * HelperNames): a deployment's own, when the host set them. Each must be
	 * an identifier no plain window has; the controller throws a TypeError
	 * otherwise. Defaults: `$s$j`, `$s$L`, `$s$N`, `$P$s`.
	 */
	names?: Partial<HelperNames>;
	/**
	 * The host's own page for a document the proxy failed to produce (a
	 * transport failure, the timeout, a routing error, a blocked rule, the
	 * refusal to proxy its own origin): a path on the service worker's origin,
	 * which in origin-isolation mode is the proxy host, not the host page's.
	 * Served with the failure's status and `globalThis.stompError`
	 * (`{ url, status, error, kind }`), never cached. Without it the built-in
	 * pages answer.
	 */
	errorPage?: string;
}

export interface ParsedConfig extends Omit<Config, 'codec'> {
	codec: GenericCodec;
}

export function parseConfig(config: Config, codecKey: string): ParsedConfig {
	let codec: GenericCodec;

	switch (config.codec) {
		case 'aes':
			codec = new AESCodec(codecKey);
			break;
		case 'xor':
			codec = new XORCodec(codecKey);
			break;
		case 'base64':
			codec = new Base64Codec(codecKey);
			break;
		case 'generic':
		default:
			codec = new GenericCodec(codecKey);
			break;
	}

	return {
		...config,
		codec,
	};
}

export function generateConfigCodecKey(codec: ConfigCodec): string {
	switch (codec) {
		case 'aes':
			return AESCodec.generateKey();
		case 'xor':
			return XORCodec.generateKey();
		case 'base64':
			return Base64Codec.generateKey();
		case 'generic':
		default:
			return GenericCodec.generateKey();
	}
}

export function codecType(codec: GenericCodec): ConfigCodec {
	if (codec instanceof AESCodec) {
		return 'aes';
	} else if (codec instanceof XORCodec) {
		return 'xor';
	} else if (codec instanceof Base64Codec) {
		return 'base64';
	} else {
		return 'generic';
	}
}

/**
 * The files `dist/` ships, by the names the host serves them under in its
 * `directory`. Every name defaults to the file's own; a host that renames
 * them (so no served URL carries the package name) says so here, and the
 * worker, the controllers and the shell build their URLs from these.
 */
export interface Assets {
	serviceWorker?: string;
	injectDocument?: string;
	injectWorker?: string;
	controllerFrame?: string;
	/** the script controllerFrame.html loads; told to the frame through `?script=` */
	controllerFrameScript?: string;
	/** the dedicated Worker that hosts a transport given as a descriptor */
	transportWorker?: string;
}

export const DEFAULT_ASSETS: Required<Assets> = {
	serviceWorker: 'serviceWorker.js',
	injectDocument: 'injectDocument.js',
	injectWorker: 'injectWorker.js',
	controllerFrame: 'controllerFrame.html',
	controllerFrameScript: 'controllerFrame.js',
	transportWorker: 'transportWorker.js',
};

/** a served file's name: the host's, else the default */
export function assetName(
	assets: Assets | undefined,
	key: keyof Assets,
): string {
	return assets?.[key] || DEFAULT_ASSETS[key];
}
