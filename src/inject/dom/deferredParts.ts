// The document bundle's deferred parts (./deferred.ts): code most frames
// never run, which no document bundle carries. build.js bundles this file on
// its own as the last statement of the rewriter library's file
// (`__stompDeferred=function(__stompShared){...};`, src/version.ts
// DEFERRED_FACTORY), which a proxied top's shell loads already; a frame
// evaluates the statement the first time it needs a part. Every module these
// import that a document bundle has too is the bundle's own, handed over in
// `__stompShared` (the snapshots, the client, the Proxy module): only the
// files build.js lists in DEFERRED_FILES are the parts' own.
//
// (and what carries WebTransport sessions, ../webTransport.ts, once a
// realm's first session starts its handshake)
//
// What belongs here: code that runs only once something has happened (a
// first read, a first call, a surface turned on) and may then wait for one
// synchronous evaluation, never a hook that must be in place before the
// page's first script. The listed files may be evaluated after page scripts
// have run, so their top level reads no global (a page may have replaced
// it): constants and functions only, as the bundle's code reads what it
// needs when it is called.
import { cookieStoreMethods } from '../cookieStoreMethods';
import { carry as carryWebTransport } from '../webTransport';
import FingerprintModule from './modules/Fingerprint';
import { emulateServiceWorker } from './modules/serviceWorkerEmulation';

const parts = {
	cookieStoreMethods,
	FingerprintModule,
	emulateServiceWorker,
	carryWebTransport,
};

export type DeferredParts = typeof parts;

// what the statement's function returns (build.js: its banner makes the
// object, its footer returns `made`). Handed over this way and not as the
// module's exports, which esbuild would build with helpers of its own that
// read Object's methods when the parts are evaluated: a page's by then
declare const __stompParts: { made?: DeferredParts };
__stompParts.made = parts;
