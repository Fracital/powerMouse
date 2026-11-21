import type { FpSurface } from './blocker/types';
import GenericCodec, { AESCodec, Base64Codec, XORCodec } from './Codecs';
import type { HelperNames } from './helperNames';
import type { ResolvedHooks } from './hooks';
import type { PasskeysConfig } from './passkeys/types';
import type { JarCookie } from './server/Cookies';
import {
	BLOCKER,
	CONTROLLER_FRAME,
	CONTROLLER_FRAME_SCRIPT,
	REWRITE_WORKER,
	SITE_FRAME_SCRIPT,
	TRANSPORT_WORKER,
} from './version';

export declare type ConfigCodec = 'generic' | 'xor' | 'aes' | 'base64';

/** what a document reads synchronously, served with it (Config syncSeed) */
export interface SyncSeed {
	/** the storage key the stores are of (an origin and its partition) */
	key: string;
	/**
	 * the cookies a request to its URL carries: document.cookie shows those
	 * that are not HttpOnly, and its synchronous requests carry them all
	 */
	cookies: JarCookie[];
	/** every key and value of its localStorage and sessionStorage, in order */
	local?: [string, string][];
	session?: [string, string][];
}

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
	 * the profile whose stores the controller's pages use (src/profile.ts):
	 * '' or absent for the default profile; the service worker refuses a
	 * controller of another profile than its own
	 */
	profile?: string;
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
	 * Set by the service worker once it knows whether a page's synchronous
	 * XMLHttpRequest reaches it (Firefox: true; Chrome and WebKit send it to
	 * the network): where it does, a page that waits on the synchronous
	 * bridge asks for its answer with one (src/server/Sync.ts answers).
	 * Unset until a page has asked.
	 */
	syncAnswers?: boolean;
	/**
	 * Set by the service worker where a page that waits synchronously stops
	 * it, and every other worker of its process, until the wait ends (WebKit;
	 * src/server/syncFrozen.ts): no answer of the synchronous bridge can
	 * come, so a document reads what its shell was served (syncSeed), writes
	 * asynchronously, and sends a synchronous request of its own to the
	 * host's server (src/inject/dom/syncRelay.ts)
	 */
	syncFrozen?: boolean;
	/**
	 * Set by the service worker where its origin is a file: page's
	 * (offline.html, demo/offline/): the routes it serves are file:// ones,
	 * which the documents (about:srcdoc frames) and workers (blob:) it
	 * serves, whose origin reads "null", make theirs on
	 */
	fileRoutes?: boolean;
	/**
	 * Where syncFrozen is: the cookies of a document's URL and its stores, as the worker had them when it served the document, for the
	 * storage key `key` (a document whose own key differs has none)
	 */
	syncSeed?: SyncSeed;
	/**
	 * Set by the service worker in the shell of a document a hard reload
	 * made (a frame's, or one of its frames'): what it loads goes past the
	 * caches until its load event is over, which it tells the worker
	 * (HARD_LOADED). Never handed on
	 */
	hardLoad?: boolean;
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
	 * Passkeys for proxied sites (docs/passkeys.md), set when the host gave
	 * the controller a `passkeys` option: a page's WebAuthn requests go to
	 * STomp's own authenticator in the service worker, and the host asks the
	 * user. Absent, a page's requests end as they do in a browser that holds
	 * no passkey for it.
	 */
	passkeys?: PasskeysConfig;
	/**
	 * @internal For tests (StompController's `fedcmTesting`): a proxied
	 * page's FedCM request ends at once, without the random delay Chrome
	 * gives a failure before its UI and the three seconds it holds a token,
	 * as Chrome does under DevTools' FedCm.enable({ disableRejectionDelay })
	 */
	fedcmTesting?: boolean;
	/**
	 * The rewriter is the Rust wasm core module in `assets/`
	 * (docs/rust-plan.md): the service worker, the rewrite workers and the
	 * inject all rewrite in it. Always `'wasm'`; a thread that holds no module
	 * yet compiles the bytes it holds synchronously (src/wasm/thread.ts), so
	 * no script is ever rewritten without it. @internal
	 */
	rewriter?: 'wasm';
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
	/**
	 * @internal the site pool (ControllerInit.sitePool): this document's origin
	 * is a slot of the pool, so the browser lists only that slot's entries of
	 * the frame's history to it, and steps into another slot's natively
	 */
	sites?: SitesConfig;
	/**
	 * @internal the hub of a site pool (ControllerInit.sitePool): its slots'
	 * origins, which are the proxy's own as much as the hub's (a route on one
	 * is a route, a route to one is refused: src/routeURL.ts proxyOrigins). Not
	 * `sites`: a document with `sites` is a slot's, and the hub's worker also
	 * serves documents of its own origin, which are no slot's.
	 */
	slotOrigins?: string[];
	/** @internal build id of the service worker that serves the page (src/version.ts) */
	build?: string;
	/** @internal ms a routed request may take before the service worker answers 504 (tests; none by default, as natively) */
	fetchTimeout?: number;
	/** @internal ms a navigation with no referrer waits for its document's hint (tests; default 100) */
	navigationHintWait?: number;
	/**
	 * The built-in blocker is on (ControllerInit.adblock): the service worker
	 * blocks what the lists block, and every document's inject applies the
	 * cosmetic rules and the scriptlets it is handed (docs/adblock.md).
	 */
	adblock?: boolean;
	/**
	 * @internal The fingerprint surfaces STomp protects for this document's host
	 * (its shields): the FingerprintModule installs a hook for each and the
	 * Memory module runs when `performanceMemory` is listed
	 * (src/inject/dom/document.ts). Absent is the default set, `performanceMemory`
	 * alone, so a default page's config is unchanged by this feature; an entry
	 * that opts a farbling/limiting surface in, or turns the master off (`[]`),
	 * sends the explicit set. Decided per document by the service worker from the
	 * per-site shields (src/server/shields.ts fingerprintConfig()).
	 */
	fingerprintOn?: FpSurface[];
	/**
	 * @internal The per-session farbling seed (ShieldsStore.seed), present only
	 * when a seeded surface (canvas/webgl/audio) is active for the document. The
	 * FingerprintModule mixes it with the document's eTLD+1 so its noise is
	 * deterministic within the site but unique across sites. The page never
	 * reads it (src/inject/dom/modules/Fingerprint.ts).
	 */
	fingerprintSeed?: number;
	/** the served file names, when the host renamed them (see Assets) */
	assets?: Assets;
	/**
	 * Just call stomp (ControllerInit.dialing): the host opted in, so the
	 * service worker serves the call page (Assets.callPage) and answers its
	 * calls for this controller. Without it neither exists.
	 */
	dialing?: boolean;
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
	 * transport failure, the timeout, a routing error, a blocked rule): a
	 * path on the service worker's origin,
	 * which in origin-isolation mode is the proxy host, not the host page's.
	 * Served with the failure's status and `globalThis.stompError`
	 * (`{ url, status, error, kind }`), never cached. Without it the built-in
	 * pages answer.
	 */
	errorPage?: string;
}

/**
 * The site pool as a document sees it (Config.sites): the hub's origin (the
 * host's page, which a proxied document never shows as a window of its
 * world) and the token every STomp document of the hub puts in a message to
 * a window of another slot's origin, which the receiver checks (a page
 * cannot make one, so a message's stated origin is the sender's inject's)
 */
export interface SitesConfig {
	/** the origin of the page whose frames show the sites (the real top) */
	hub: string;
	token: string;
	/**
	 * the origin of the hub's controller, whose worker shows a slot's
	 * documents once the slot's agent is gone: `hub`'s own, or the proxy's
	 * when the hub is a controller frame (RemoteController)
	 */
	home?: string;
	/**
	 * the pool's slots' origins: a navigation to a site of another slot is
	 * a 307 there, which the browser's copy of a page's frame-src and
	 * form-action lets through (src/csp.ts browserPolicy), and what the
	 * browser names on another slot's origin is read as the route's real
	 * URL (src/inject/dom/modules/ContentSecurity.ts)
	 */
	origins?: string[];
}

/**
 * The site pool: the property of a slot's agent window (src/controller/site.ts)
 * that holds the hub's frame that has focus there, which a top document of
 * the slot reads as it starts (src/inject/dom/siteWindows.ts keepTopFocus)
 */
export const SITE_FOCUS = '$stomp$siteFocus';

/**
 * The site pool: the property of a slot's agent window (and of the hub's,
 * the controller frame's, for a site shown without the pool) that holds
 * what the hub last told of each of its frames' runs of history
 * (src/controller/history.ts expectRuns): the length a top document's
 * history has when the browser navigated the frame to it by a push, and by
 * a replace or reload, which it reads as it starts (the Navigate module),
 * before the hub's count of the other slots' entries reaches it
 */
export const SITE_RUNS = '$stomp$siteRuns';

/**
 * The property of the hub's window (the host's page, or an isolated
 * RemoteController's controller frame) and of each slot's agent window that
 * holds the host's browser window as its frames' documents see it
 * (src/controller/geometry.ts): a proxied document reads its outer size and
 * screen position from it (src/inject/dom/hostGeometry.ts)
 */
export const HOST_GEOMETRY = '$stomp$hostGeometry';

/** what HOST_GEOMETRY holds, measured in the host's page (its real top) */
export interface HostGeometry {
	/**
	 * the browser's own UI around the host's viewport: outerWidth minus
	 * innerWidth, outerHeight minus innerHeight
	 */
	chrome: readonly [number, number];
	/**
	 * each frame of the host's page by its index in the page's `frames`:
	 * where its viewport is in the host's (left, top) and how much of the
	 * host's viewport is not the frame's (width, height); null for a frame
	 * that shows no proxied page
	 */
	frames: readonly (readonly [number, number, number, number] | null)[];
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
	/** the script controllerFrame.html loads as a slot's agent of the site pool (ControllerInit.sitePool) */
	siteFrameScript?: string;
	/** the dedicated Worker that hosts a transport given as a descriptor */
	transportWorker?: string;
	/** the dedicated Worker a document starts for its WebRTC connections (docs/webrtc-over-wisp.md) */
	rtcWorker?: string;
	/** the WebRTC stack's wasm module */
	rtc?: string;
	/** what a document's WebRTC classes do, loaded the first time it uses them */
	rtcStack?: string;
	/**
	 * the extensions' runtime (docs/extensions.md): only a document an
	 * installed extension reaches loads it, before its inject bundle; the
	 * service worker names it in that document's shell
	 */
	extensionsRuntime?: string;
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
	 * the built-in blocker's default scriptlets and redirect resources,
	 * uBlock Origin's (docs/adblock.md), which the service worker reads when
	 * `init.adblock` names no `resources`
	 */
	adblockResources?: string;
	/**
	 * the built-in blocker's engine snapshot of the default lists, gzipped
	 * (docs/adblock.md, "The snapshot"), which a service worker with no
	 * engine stored decompresses and serves while it fetches the lists.
	 * Serve it as it is (`application/octet-stream`, no `Content-Encoding`).
	 * It is asked for as `<name>?<hash of its bytes>`, so it can be cached
	 * for good.
	 */
	adblockSnapshot?: string;
	/**
	 * The light rewriter library (the wasm glue, src/rewriterLightDocument.ts):
	 * no document bundle carries it. A proxied top's shell loads this file,
	 * and a sandboxed frame fetches it the first time it rewrites. It is asked
	 * for as `<name>?<hash of its bytes>`, so it can be cached for as long as
	 * the host likes. The rewriter itself is the wasm `core` module.
	 */
	rewriterLib?: string;
	/**
	 * Just call stomp's call page (ControllerInit.dialing): the one page
	 * every dialed frame loads, `<scope><callPage>` (`?<depth>` below the
	 * tab's frame). No file of dist/ is behind it: the service worker
	 * serves it, and only to a controller that opted in, so a host names
	 * it and serves nothing. It is the URL the browser shows for every
	 * dialed frame, so a host that wants that URL to say nothing names it
	 * as it names its other files (a neutral name of its own, per build)
	 */
	callPage?: string;
	/**
	 * the host's omnibox (src/omnibox/), a classic script whose global is
	 * `Omnibox`: no proxied page and no bundle of the controller's loads it,
	 * a host page that wants it loads it by this name
	 */
	omnibox?: string;
}

/** the files the bundles ask for themselves (assetName) */
export type BundleAsset = Exclude<keyof Assets, 'omnibox'>;

const BUNDLE_ASSETS: Required<Pick<Assets, BundleAsset>> = {
	serviceWorker: 'serviceWorker.js',
	injectDocument: 'injectDocument.js',
	injectWorker: 'injectWorker.js',
	injectDocumentFull: 'injectDocumentFull.js',
	injectWorkerFull: 'injectWorkerFull.js',
	controllerFrame: 'controllerFrame.html',
	controllerFrameScript: 'controllerFrame.js',
	siteFrameScript: 'siteFrame.js',
	transportWorker: 'transportWorker.js',
	rtcWorker: 'rtcWorker.js',
	rtc: 'rtc.wasm',
	rtcStack: 'rtcStack.js',
	extensionsRuntime: 'extensionsRuntime.js',
	rewriteWorker: 'rewriteWorker.js',
	core: 'core.wasm',
	blocker: 'blocker.wasm',
	adblockResources: 'adblock-resources.json',
	adblockSnapshot: 'adblock-snapshot.dat.gz',
	rewriterLib: 'rewriterLib.js',
	// (no file: the worker's page; a neutral name, as a host renames it)
	callPage: 'k3v9.html',
};

/**
 * Every file's name. The ones only a host page loads are not among the
 * bundles' (BUNDLE_ASSETS), so no inject bundle carries them.
 */
export const DEFAULT_ASSETS: Required<Assets> = /* @__PURE__ */ Object.assign(
	{ omnibox: 'omnibox.js' },
	BUNDLE_ASSETS,
);

/**
 * The wasm artifacts, by Assets key: what a controller running
 * `rewriter: 'wasm'` loads and hands to the service worker and its rewrite
 * workers (src/wasm/thread.ts)
 */
export const WASM_ASSETS = ['core'] as const satisfies (keyof Assets)[];

/** a served file's name: the host's, else the default */
export function assetName(
	assets: Assets | undefined,
	key: BundleAsset,
): string {
	return assets?.[key] || BUNDLE_ASSETS[key];
}

/**
 * A file the controller starts, as it asks for it: its name and the hash of
 * this build's bytes (src/version.ts TRANSPORT_WORKER), so that one URL is
 * one file and a host may answer it `immutable`. The name alone in a
 * build with no hashes (the watch build).
 */
export function assetFile(
	assets: Assets | undefined,
	key:
		| 'transportWorker'
		| 'rewriteWorker'
		| 'blocker'
		| 'controllerFrame'
		| 'controllerFrameScript'
		| 'siteFrameScript',
): string {
	const hash = {
		transportWorker: TRANSPORT_WORKER,
		rewriteWorker: REWRITE_WORKER,
		blocker: BLOCKER,
		controllerFrame: CONTROLLER_FRAME,
		controllerFrameScript: CONTROLLER_FRAME_SCRIPT,
		siteFrameScript: SITE_FRAME_SCRIPT,
	}[key];
	const name = assetName(assets, key);
	return hash ? `${name}?${encodeURIComponent(hash)}` : name;
}
