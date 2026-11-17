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
// (and Chrome 157's markup insertion members, ./markupMembers.ts, at a
// page's first call of one)
//
// (and XMLHttpRequest's argument checks, ../xhrChecks.ts, at a document's
// first open(); a worker's bundle has them itself)
//
// (and the WebTransport stand-in, ../webTransportStandIn.ts, with what
// carries its sessions, ../webTransport.ts, once a realm makes its first
// session)
//
// (STomp's passkey provider's WebAuthn client is a deferred statement of
// its own, ./passkeysPart.ts: few documents call WebAuthn, and every frame
// that needs a part here compiles all of them)
//
// What belongs here: code that runs only once something has happened (a
// first read, a first call, a surface turned on) and may then wait for one
// synchronous evaluation, never a hook that must be in place before the
// page's first script. The listed files may be evaluated after page scripts
// have run, so their top level reads no global (a page may have replaced
// it): constants and functions only, as the bundle's code reads what it
// needs when it is called.
import { cookieStoreMethods } from '../cookieStoreMethods';
import { recordSize } from '../idbSize';
import { carry as carryWebTransport } from '../webTransport';
import { standIn as webTransportStandIn } from '../webTransportStandIn';
import { checkedHeader, checkedMethod, notOpened } from '../xhrChecks';
import { ancestorOriginsList } from './ancestorOriginsList';
import { attributeViewMethods } from './attributeViewMethods';
import { relayBeacon } from './beaconRelay';
import { markupMembers } from './markupMembers';
import FingerprintModule from './modules/Fingerprint';
import { emulateServiceWorker } from './modules/serviceWorkerEmulation';
import { sourcePolicy } from './sourcePolicy';

const parts = {
	cookieStoreMethods,
	relayBeacon,
	ancestorOriginsList,
	attributeViewMethods,
	sourcePolicy,
	recordSize,
	checkedMethod,
	checkedHeader,
	notOpened,
	FingerprintModule,
	emulateServiceWorker,
	markupMembers,
	webTransportStandIn,
	carryWebTransport,
};

export type DeferredParts = typeof parts;

// what the statement's function returns (build.js: its banner makes the
// object, its footer returns `made`). Handed over this way and not as the
// module's exports, which esbuild would build with helpers of its own that
// read Object's methods when the parts are evaluated: a page's by then
declare const __stompParts: { made?: DeferredParts };
__stompParts.made = parts;
