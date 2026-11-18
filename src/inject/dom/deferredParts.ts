// The document bundle's deferred parts (./deferred.ts): code most frames
// never run, which no document bundle carries. build.js builds them as the
// last statement of the rewriter library's file but one
// (`__stompDeferred=function(__stompShared,__stompPart){...};`, src/version.ts
// DEFERRED_FACTORY), which a proxied top's shell loads already: a switch with
// a case for each group of parts, a group being the parts this file imports
// from one file (and from every other file that reaches one module with it,
// so a module is evaluated once in a realm). A frame evaluates the case of
// a part's group alone, cut out of the statement's text, the first time it
// needs one of its parts (../rewriter.ts partGroup). Every
// module these import that a document bundle has too is the bundle's own,
// handed over by `__stompShared` (the snapshots, the client, the Proxy
// module): only the files build.js lists in DEFERRED_FILES are the parts'
// own. This file is not built itself: build.js reads its imports, and
// `parts` names each of them once.
//
// (and Chrome 157's markup insertion members, ./markupMembers.ts, at a
// page's first call of one)
//
// (and the rare markup sinks, execCommand's markup and links,
// createContextualFragment, setHTMLUnsafe, setHTML, getHTML,
// serializeToString, with the document.domain setter, ./markupSinks.ts, at
// a page's first call of one; a group apart from the insertion members)
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
// with the transport it talks over and what the WebSocket stand-ins do, at
// its first WebSocket)
//
// (and the blocker's procedural cosmetic filters, ../../blocker/procedural.ts,
// at a document whose lists have one for its site)
//
// (and the page's own Content-Security-Policy checks, ./policyChecks.ts
// with ../../cspJudge.ts and the digests of ../../sha.ts, at the first
// check a document with a policy of the page's makes, with a data: URL's
// integrity, ../../sriDigest.ts, which shares the digests)
//
// (and the document.write stream, ./WriteStream.ts with its tokenizer, at a
// document's first write)
//
// (and the checks of navigator.registerProtocolHandler() and
// unregisterProtocolHandler(), ./protocolHandlers.ts, at a page's first call)
//
// (and what performance.measureUserAgentSpecificMemory() answers, with the
// page's own URLs, ./measuredMemory.ts, at a page's first call of it)
//
// (and the font faces of a sheet copied for a document no service worker
// controls, ./lazyFonts.ts, at the first such face)
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
// (and the per-site legacy file system, ../legacyFileSystem.ts, at a
// realm's first call of it)
//
// (and the WebTransport stand-in, ../webTransportStandIn.ts, with what
// carries its sessions, ../webTransport.ts, once a realm makes its first
// session)
// (and window.open(), ./windowOpen.ts, at a document's first call)
//
// (and the watch of which images a document lays out in its viewport,
// ./seenImages.ts, once the worker says one of them waits for a connection)
//
// (and what routes xml-stylesheet processing instructions and an XML
// document's prolog, ./instructions.ts, at the first one a document meets)
//
// (and the shells of a document the page makes itself that no worker
// serves, ../../htmlShell.ts and ../../xmlShell.ts, at a document's first
// srcdoc, object or embed document, javascript: URL markup or data: URL
// document)
//
// (STomp's passkey provider's WebAuthn client is a deferred statement of
// its own, ./passkeysPart.ts: few documents call WebAuthn, and a top that
// needs a part here has the statement of all of them; and so are
// the gates of the
// gesture-gated calls, ./activationPart.ts, which every frame a click
// elsewhere reaches through the proxy needs and little else)
//
// What belongs here: code that runs only once something has happened (a
// first read, a first call, a surface turned on) and may then wait for one
// synchronous evaluation, never a hook that must be in place before the
// page's first script. The listed files may be evaluated after page scripts
// have run, so their top level reads no global (a page may have replaced
// it): constants and functions only, as the bundle's code reads what it
// needs when it is called.
import { compileFilter, proceduralRunner } from '../../blocker/procedural';
import { modifyHTML } from '../../htmlShell';
import { noticeText } from '../../mixedContentNotices';
import { integrityHoldsSync } from '../../sriDigest';
import { modifyXML } from '../../xmlShell';
import { accessFailures } from '../accessFailures';
import { bareClient, socketStandIns } from '../bareClient';
import { cookieChanges, cookieStoreMethods } from '../cookieStoreMethods';
import { hookDevices } from '../deviceGrants';
import { recordSize } from '../idbSize';
import {
	dropLegacyFileSystem,
	partitionLegacyFileSystem,
} from '../legacyFileSystem';
import {
	gateCall,
	gateGetter,
	notificationParts,
	permissionElements,
} from '../permissionGates';
import { reportsSeen } from '../reportsSeen';
import { bucketMethods } from '../storageBucketMethods';
import { storageUsage } from '../storageUsage';
import { carry as carryWebTransport } from '../webTransport';
import { standIn as webTransportStandIn } from '../webTransportStandIn';
import { workerStart } from '../workerStart';
import { checkedHeader, checkedMethod, notOpened } from '../xhrChecks';
import { ancestorOriginsList } from './ancestorOriginsList';
import { attributeViewMethods } from './attributeViewMethods';
import { relayBeacon } from './beaconRelay';
import { identityFlow, relyingPartyGuard } from './credentialFlows';
import { ownStoreRefusal } from './credentialStore';
import { saveDownload } from './downloadSave';
import { fetchLater } from './fetchLater';
import { instructionData, loadXML, xmlProlog } from './instructions';
import { lazyFonts } from './lazyFonts';
import { formEncoding, legacyFormQuery, legacyQuery } from './legacyEncoding';
import { markupMembers } from './markupMembers';
import { markupSinks } from './markupSinks';
import { measuredMemory } from './measuredMemory';
import FingerprintModule from './modules/Fingerprint';
import { longFrames } from './modules/LongFrames';
import { longTasks } from './modules/LongTasks';
import {
	deviceConstraints,
	notificationCall,
	permissionRequests,
	positionCall,
	userMediaCall,
} from './modules/permissionCalls';
import { emulateServiceWorker } from './modules/serviceWorkerEmulation';
import { navigateOther } from './navigateOther';
import { navigationRefusal, precommitRedirect } from './navigationRefusal';
import { openerFacts, opensWithoutOpener } from './openerFacts';
import { pictureWindows } from './pictureWindows';
import { policyChecks } from './policyChecks';
import { presentationIds } from './presentations';
import { protocolHandler } from './protocolHandlers';
import { rtcInstall } from './rtcInstall';
import { seenImages } from './seenImages';
import {
	acceptAcross,
	ancestorAcross,
	formSubmission,
	locationAcross,
	navigateAcross,
	submitAimed,
	targetAcross,
} from './siteAcross';
import {
	judgeAcross,
	onOwnSlot,
	receiveAcross,
	slotContainerPolicy,
} from './siteEvents';
import { sourcePolicy } from './sourcePolicy';
import { storageAccessHandle } from './storageAccess';
import { uncontrolledCopies } from './uncontrolledCopies';
import {
	dispatchViolation,
	evalError,
	refusedTrustedPolicy,
	trustedTypeError,
	violationPageCode,
	violationShows,
	violationURL,
} from './violations';
import { windowOpen } from './windowOpen';
import { writeStream } from './WriteStream';
import { xhrMessage } from './xhrMessages';
import { responseParser } from './xhrParse';

export const parts = {
	bareClient,
	// what the WebSocket and WebSocketStream stand-ins do, with the client
	// (../bareClient.ts; ../socketParts.ts, ../modules/WebSocket.ts)
	socketStandIns,
	// a mixed content notice's text, at a document's first notice
	// (../../mixedContentNotices.ts; ../modules/MixedContent.ts)
	noticeText,
	// the wording of the access API's errors, at a document's first
	// (../accessFailures.ts; ../errorMessages.ts)
	accessFailures,
	// the un-routing of ReportingObserver's reports, at the first
	// (../reportsSeen.ts; ../modules/Unroute.ts)
	reportsSeen,
	// what a worker's construction does past its checks, at a document's
	// first (../workerStart.ts; ../modules/Worker.ts)
	workerStart,
	compileFilter,
	proceduralRunner,
	// what measureUserAgentSpecificMemory() answers the page, at its first
	// call (./measuredMemory.ts; ./modules/Isolation.ts)
	measuredMemory,
	// navigator.(un)registerProtocolHandler()'s checks, at a page's first
	// call (./protocolHandlers.ts; ./modules/Navigator.ts)
	protocolHandler,
	longFrames,
	longTasks,
	cookieStoreMethods,
	// the change events of a document's cookieStore, at the first change
	// after the page looked (../cookieStoreMethods.ts; modules/CookieStore.ts)
	cookieChanges,
	relayBeacon,
	// fetchLater's call, at a document's first (./fetchLater.ts;
	// modules/Navigator.ts)
	fetchLater,
	ancestorOriginsList,
	attributeViewMethods,
	sourcePolicy,
	recordSize,
	// the usage walk behind navigator.storage.estimate(), at a realm's
	// first (../storageUsage.ts; ../modules/StorageEstimate.ts)
	storageUsage,
	partitionLegacyFileSystem,
	dropLegacyFileSystem,
	checkedMethod,
	checkedHeader,
	notOpened,
	FingerprintModule,
	userMediaCall,
	deviceConstraints,
	positionCall,
	notificationCall,
	// the Permissions module's requests, at a page's first
	// (./modules/permissionCalls.ts; ./modules/Permissions.ts)
	permissionRequests,
	rtcInstall,
	responseParser,
	xhrMessage,
	emulateServiceWorker,
	markupMembers,
	// the rare markup sinks' work and the document.domain setter's, at a
	// page's first call of one (./markupSinks.ts; modules/DOMHooks.ts)
	markupSinks,
	// a document's navigation of another window, refused as Chrome refuses
	// it, at its first (./navigateOther.ts; modules/Context.ts)
	navigateOther,
	// the copies a document no service worker controls makes of its loads,
	// at its first (./uncontrolledCopies.ts; ./modules/DOMAttributes.ts)
	uncontrolledCopies,
	// the violations and errors of the page's own policy the inject makes
	// itself, the first time it refuses something (./violations.ts; Client.ts)
	dispatchViolation,
	refusedTrustedPolicy,
	trustedTypeError,
	evalError,
	// and the reading of the browser's own violations, at the first that
	// reaches the page (./modules/ContentSecurity.ts)
	violationShows,
	violationURL,
	violationPageCode,
	// the page's own policy's checks of its code and of the loads no worker
	// sees, at the first a document with a policy needs (./policyChecks.ts;
	// Client.ts), and a data: URL's integrity, which shares their digests
	// (../../sriDigest.ts; modules/DOMAttributes.ts)
	policyChecks,
	integrityHoldsSync,
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
	// a copied sheet's font faces, at the first a document no service worker
	// controls copies (./uncontrolledCopies.ts)
	lazyFonts,
	gateCall,
	gateGetter,
	notificationParts,
	permissionElements,
	hookDevices,
	instructionData,
	xmlProlog,
	// the loading of an XML document, at the XML shell's call
	// (./instructions.ts; Client.loadXML)
	loadXML,
	// the shells of a document the page makes that no worker serves, at a
	// document's first (../../htmlShell.ts, ../../xmlShell.ts; an srcdoc, an
	// object's copy, a javascript: URL's markup, a data: URL)
	modifyHTML,
	modifyXML,
	ownStoreRefusal,
	targetAcross,
	navigateAcross,
	acceptAcross,
	ancestorAcross,
	locationAcross,
	submitAimed,
	formSubmission,
	judgeAcross,
	receiveAcross,
	onOwnSlot,
	slotContainerPolicy,
	seenImages,
	// window.open(), at a document's first call (./windowOpen.ts;
	// modules/DOMHooks.ts)
	windowOpen,
};

export type DeferredParts = typeof parts;
