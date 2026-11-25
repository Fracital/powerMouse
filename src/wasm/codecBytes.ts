// The codec module's bytes (rust/codec, assets/codec.wasm) as the document
// bundle's realm compiles them (./codec.ts): a deferred part
// (src/inject/dom/deferredParts.ts), which a proxied top's shell loaded
// before its bundle, so the top compiles its instance from it with no wait
// and no request, and the frames under it seal in that instance and never
// evaluate this. The worker bundles and the service worker carry the bytes
// themselves (build.js STOMP_CODEC_WASM). The instance's code is the part's
// too (./codecInstance.ts), in the same group as the bytes.
export { codecInstance } from './codecInstance';

// esbuild replaces this at build time (build.js `define`)
declare const process: { env: Record<string, string | undefined> };

/** the module's bytes, base64url */
export const codecBytes = (): string | undefined =>
	process.env.STOMP_CODEC_WASM || undefined;
