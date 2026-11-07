import GenericCodec, { AESCodec, Base64Codec, XORCodec } from './Codecs';

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
	 * HTTP cache in the service worker (off by default): GET/HEAD responses
	 * with explicit freshness are served from a Cache API store and
	 * revalidated with ETag / Last-Modified when stale.
	 */
	cache?: boolean;
	/** @internal the host wants a RequestInfo per request (ControllerInit.onRequest) */
	requestLog?: boolean;
	/** @internal build id of the service worker that serves the page (src/version.ts) */
	build?: string;
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
