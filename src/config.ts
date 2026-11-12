import GenericCodec, { AESCodec, Base64Codec, XORCodec } from './Codecs';
import type { HelperNames } from './helperNames';
import type { ResolvedHooks } from './hooks';

export declare type ConfigCodec = 'generic' | 'xor' | 'aes' | 'base64';

export interface Config {
	codec: ConfigCodec;
	/**
	 * pathname this controller's routes live under: the scope plus the
	 * controller's id, e.g. `/stomp/k7qx2m/` (its address in the service
	 * worker; every routed URL starts with it)
	 */
	directory: string;
	/**
	 * pathname of the directory the service worker is scoped to and the
	 * bundles are served from, e.g. `/stomp/`; shared by every controller of
	 * that scope, and the only thing the asset URLs are built from
	 */
	scope: string;
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
	 * Set by the controller when its transport runs in the transport worker,
	 * where a synchronous request from a page completes (with the transport
	 * in the page the spin would block it): a document no service worker
	 * controls then loads a script the page writes synchronously, in order.
	 */
	workerTransport?: boolean;
	/**
	 * HTTP cache in the service worker, on unless `false`: GET responses are
	 * kept in a Cache API store and served or revalidated with ETag /
	 * Last-Modified as Chrome's HTTP cache does (docs/http-cache.md).
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
	/**
	 * The window membrane (on unless `false`): every window and object of
	 * another proxied site's realm reaches a page through a proxy that checks,
	 * on each use, which site the window shows now (see StompController)
	 */
	membrane?: boolean;
	/**
	 * Emulated service workers (on unless `false`): a page's
	 * `navigator.serviceWorker` registers workers that run in a dedicated
	 * Worker the controller starts, and STomp's own service worker hands them
	 * the page's requests (docs/service-workers.md). Off, pages have no
	 * `navigator.serviceWorker` (a proxy tell: every Chrome page in a secure
	 * context has one).
	 */
	serviceWorkers?: boolean;
	/**
	 * Which rewriter backend the service worker, the rewrite workers and the
	 * inject use: `'js'` (default) the JavaScript rewriters, `'wasm'` the
	 * Rust modules in `assets/` (docs/rust-plan.md) wherever a thread holds
	 * them, with the JavaScript rewriter answering for whatever a module
	 * declines or has not reached yet
	 */
	rewriter?: 'wasm' | 'js';
	/**
	 * @internal `false` in the config of a document the service worker
	 * serves under a blocking list's own policy (`$csp=`, docs/adblock.md):
	 * its realm, and what it creates under that policy, compiles no codec
	 * module (the policy may refuse it and would report the attempt to the
	 * page) and seals its URLs in JavaScript, the same text
	 * (src/wasm/codec.ts)
	 */
	codecModule?: false;
	/** @internal ms an emulated service worker may take to say whether it answers a request (tests; default 5000, a start twice that, an answer six times) */
	serviceWorkerTimeout?: number;
	/** @internal ms every emulated service worker event waits before it reaches the pages (tests: the events trail the answers to the pages' calls) */
	serviceWorkerEventDelay?: number;
	/**
	 * @internal the context that shows the proxied frames (the host's page, or
	 * the controller's frame in it) is cross-origin isolated: the service
	 * worker then serves every document so it loads there, and isolated only
	 * when its own headers isolate it natively (src/isolation.ts). Never an
	 * option: the controller reads `crossOriginIsolated`.
	 */
	isolated?: boolean;
	/** @internal build id of the service worker that serves the page (src/version.ts) */
	build?: string;
	/** @internal ms a routed request may take before the service worker answers 504 (tests; default by destination) */
	fetchTimeout?: number;
	/** @internal ms a navigation with no referrer waits for its document's hint (tests; default 100) */
	navigationHintWait?: number;
	/**
	 * The built-in blocker is on (ControllerInit.adblock): the service worker
	 * blocks what the lists block, and every document's inject applies the
	 * cosmetic rules and the scriptlets it is handed (docs/adblock.md).
	 */
	adblock?: boolean;
	/** the served file names, when the host renamed them (see Assets) */
	assets?: Assets;
	/**
	 * The global names the rewriter and the inject bundles use (see
	 * HelperNames): a deployment's own, when the host set them, and the
	 * client's the controller minted otherwise. Defaults: `$s$j`, `$s$L`,
	 * `$s$N` (`$P$s` for the client only where no controller named one).
	 */
	names?: Partial<HelperNames>;
	/**
	 * Host code run in every proxied realm, as resolved text (see
	 * src/hooks.ts; the controllers take `init.hooks` with sources or URLs
	 * and put the text here).
	 */
	hooks?: ResolvedHooks;
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

/**
 * Whether `key` is a key the codec makes today. A stored xor key of the
 * codec before docs/codec.md (three hex digits at the most) is not: the
 * worker draws a new one, as for a first visit.
 */
export function validConfigCodecKey(codec: ConfigCodec, key: unknown): boolean {
	if (typeof key !== 'string') return false;
	return codec === 'xor' ? XORCodec.validKey(key) : true;
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
	/**
	 * the inject bundles that carry crypto-js (build.js), served to the aes
	 * and base64 codecs, which read it; the xor and generic codecs read none,
	 * so they load the crypto-free injectDocument/injectWorker instead
	 * (src/routeURL.ts)
	 */
	injectDocumentFull?: string;
	injectWorkerFull?: string;
	controllerFrame?: string;
	/** the script controllerFrame.html loads; told to the frame through `?script=` */
	controllerFrameScript?: string;
	/** the dedicated Worker that hosts a transport given as a descriptor */
	transportWorker?: string;
	/** the dedicated Worker a document starts for its WebRTC connections (docs/webrtc-over-wisp.md) */
	rtcWorker?: string;
	/** the WebRTC stack's wasm module */
	rtc?: string;
	/** what a document's WebRTC classes do, loaded the first time it uses them */
	rtcStack?: string;
	/** the dedicated Workers that rewrite scripts for the service worker */
	rewriteWorker?: string;
	/**
	 * The core wasm module (docs/rust-plan.md): the JS rewriter, the CSS
	 * rewriter and markup scanner, and the public suffix lookup, built into
	 * one artifact
	 */
	core?: string;
	/** the built-in blocker's wasm module (docs/adblock.md) */
	blocker?: string;
	/**
	 * The rewriter library (meriyah, escodegen, css-tree, tldts and the
	 * rewriters on them): no inject bundle carries it. A proxied top's shell
	 * loads this file, and a worker fetches it the first time it rewrites.
	 * A controller fetches it when it starts and fails when the host does
	 * not serve it; it is asked for as `<name>?<hash of its bytes>`, so it
	 * can be cached for as long as the host likes (docs/rust-plan.md,
	 * section 6)
	 */
	rewriterLib?: string;
}

export const DEFAULT_ASSETS: Required<Assets> = {
	serviceWorker: 'serviceWorker.js',
	injectDocument: 'injectDocument.js',
	injectWorker: 'injectWorker.js',
	injectDocumentFull: 'injectDocumentFull.js',
	injectWorkerFull: 'injectWorkerFull.js',
	controllerFrame: 'controllerFrame.html',
	controllerFrameScript: 'controllerFrame.js',
	transportWorker: 'transportWorker.js',
	rtcWorker: 'rtcWorker.js',
	rtc: 'rtc.wasm',
	rtcStack: 'rtcStack.js',
	rewriteWorker: 'rewriteWorker.js',
	core: 'core.wasm',
	blocker: 'blocker.wasm',
	rewriterLib: 'rewriterLib.js',
};

/**
 * The wasm artifacts, by Assets key: what a controller running
 * `rewriter: 'wasm'` loads and hands to the service worker and its rewrite
 * workers (src/wasm/thread.ts)
 */
export const WASM_ASSETS = ['core'] as const satisfies (keyof Assets)[];

/** a served file's name: the host's, else the default */
export function assetName(
	assets: Assets | undefined,
	key: keyof Assets,
): string {
	return assets?.[key] || DEFAULT_ASSETS[key];
}
