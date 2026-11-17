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
// (and the SecurityError of a navigation a page may not intercept, with a
// precommit handler's redirect, ./navigationRefusal.ts, when one is refused
// or redirected)
//
// (and XMLHttpRequest's argument checks, ../xhrChecks.ts, at a document's
// first open(); a worker's bundle has them itself)
//
// (and what a legacy-encoded document encodes a URL's query and a form's
// submission with, ./legacyEncoding.ts, at its first such URL or form)
//
// (and the client a document opens its WebSockets with, ../bareClient.ts,
// with the transport it talks over, at its first WebSocket)
//
// (and the blocker's procedural cosmetic filters, ../../blocker/procedural.ts,
// at a document whose lists have one for its site)
//
// (and the document.write stream, ./WriteStream.ts with its tokenizer, at a
// document's first write)
//
// (and the handlers of long tasks and long animation frames,
// ./modules/LongTasks.ts and ./modules/LongFrames.ts, at a document's first
// such entry)
// (and a StorageAccessHandle's members, ./storageAccess.ts, at a page's
// first use of one)
//
// (and the presentation ids a site was handed, ./presentations.ts, at a
// page's first PresentationRequest start(), reconnect() or connection)
//
// (and the permission gates, ../permissionGates.ts, and the device
// grants, ../deviceGrants.ts, at a page's first call of a gated API or
// first read of a device API; a worker's bundle has them itself)
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
import { compileFilter } from '../../blocker/procedural';
import { bareClient } from '../bareClient';
import { cookieStoreMethods } from '../cookieStoreMethods';
import { hookDevices } from '../deviceGrants';
import { recordSize } from '../idbSize';
import {
	gateCall,
	gateGetter,
	notificationParts,
	permissionElements,
} from '../permissionGates';
import { bucketMethods } from '../storageBucketMethods';
import { carry as carryWebTransport } from '../webTransport';
import { standIn as webTransportStandIn } from '../webTransportStandIn';
import { checkedHeader, checkedMethod, notOpened } from '../xhrChecks';
import { ancestorOriginsList } from './ancestorOriginsList';
import { attributeViewMethods } from './attributeViewMethods';
import { relayBeacon } from './beaconRelay';
import { identityFlow, relyingPartyGuard } from './credentialFlows';
import { saveDownload } from './downloadSave';
import { formEncoding, legacyFormQuery, legacyQuery } from './legacyEncoding';
import { markupMembers } from './markupMembers';
import FingerprintModule from './modules/Fingerprint';
import { longFrames } from './modules/LongFrames';
import { longTasks } from './modules/LongTasks';
import { emulateServiceWorker } from './modules/serviceWorkerEmulation';
import { navigationRefusal, precommitRedirect } from './navigationRefusal';
import { openerFacts, opensWithoutOpener } from './openerFacts';
import { pictureWindows } from './pictureWindows';
import { presentationIds } from './presentations';
import { sourcePolicy } from './sourcePolicy';
import { storageAccessHandle } from './storageAccess';
import { writeStream } from './WriteStream';

const parts = {
	bareClient,
	compileFilter,
	longFrames,
	longTasks,
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
	navigationRefusal,
	precommitRedirect,
	webTransportStandIn,
	carryWebTransport,
	legacyQuery,
	formEncoding,
	legacyFormQuery,
	bucketMethods,
	pictureWindows,
	openerFacts,
	opensWithoutOpener,
	writeStream,
	// the FedCM flow and the guard of the browser's WebAuthn calls, at a
	// document's first such call (modules/Credentials.ts)
	identityFlow,
	relyingPartyGuard,
	storageAccessHandle,
	presentationIds,
	// a same-origin download's copy, at a document's first (modules/Download.ts)
	saveDownload,
	gateCall,
	gateGetter,
	notificationParts,
	permissionElements,
	hookDevices,
};

export type DeferredParts = typeof parts;

// what the statement's function returns (build.js: its banner makes the
// object, its footer returns `made`). Handed over this way and not as the
// module's exports, which esbuild would build with helpers of its own that
// read Object's methods when the parts are evaluated: a page's by then
declare const __stompParts: { made?: DeferredParts };
__stompParts.made = parts;
