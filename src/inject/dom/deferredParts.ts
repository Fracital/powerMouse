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
// (and what a tainted source's refusals say, ./taintRefusals.ts, at a
// document's first such refusal)
//
// (and what a page's Cache API add(), addAll() and caches.match() do past
// their hooks' checks, ../cacheCalls.ts, at a realm's first; a worker's
// bundle has it itself)
//
// (and the reader of the position map a script file's rewrite carries,
// ../positionMaps.ts, at a document's first position asked of such a file:
// a stack's place, a long animation frame's script; a worker's bundle has
// it itself)
//
// (and what Origin.from() answers a page, ../originFrom.ts, at a realm's
// first call; a worker's bundle has it itself)
//
// (and what reads a window as an array method or as a list of arguments
// does, ../windowArrays.ts, at a document's first such call: a worker's
// scope has none)
//
// (and the codec module's bytes, ../../wasm/codecBytes.ts, which a
// proxied top compiles at its first seal from the parts its shell loaded:
// the frames under it seal in its instance)
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
// (and whether a URL matches a source list of the page's own policy,
// ../../cspSources.ts, at the first load or navigation a policy of the
// page's governs that the document judges itself; a group of its own, as
// the checks above carry their own copy)
//
// (and a form's submission as the worker is told of it and the page's
// form-action judges it, ./formSubmissions.ts, at a document's first)
//
// (and a link opened in a new browsing context as a host tab or a sandboxed
// popup, ./linkOpens.ts, at a document's first click on one)
//
// (and navigator.credentials.get(), store() and preventSilentAccess() past
// their hooks, ./credentialCalls.ts, at a document's first call of one)
//
// (and a media session's artwork routed and read back, ./mediaArtwork.ts, at
// a document's first)
//
// (and a javascript: URL's document and navigation.navigate(),
// ./navigateCalls.ts, at a document's first of either)
//
// (and a click on a link to a fragment of the document, ./fragmentLinks.ts,
// at a document's first)
//
// (and window.viewport.segments and what an opaque document is refused,
// ./rareReads.ts, at a document's first of either)
//
// (and what document.startViewTransition() does in a frame past its hook,
// ./viewTransitions.ts, at a page's first call)
//
// (and a page's import map as the browser gets it, ./importMaps.ts with
// ../../importMap.ts, at a document's first import map)
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
// (and the loads of an <object>'s data and an <embed>'s src,
// ./objectLoads.ts, at a document's first object or embed with a URL)
//
// (and the font faces of a sheet copied for a document no service worker
// controls, ./lazyFonts.ts, at the first such face)
//
// (and the ask for a synchronous request's answer, ./syncAnswer.ts, at a
// document's first wait on the bridge)
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
// document; with them the rare branches of DOMAttributes' hooks,
// ./rareAttributes.ts with ../../refresh.ts, at a document's first data:
// frame, refresh meta or report-only refusal of a base)
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
import { sourcesMatch } from '../../cspSources';
import { modifyHTML } from '../../htmlShell';
import { noticeText } from '../../mixedContentNotices';
import { dataIntegrity } from '../../sriDigest';
import { codecBytes, codecInstance } from '../../wasm/codecBytes';
import { modifyXML } from '../../xmlShell';
import { accessFailures } from '../accessFailures';
import { bareClient, socketStandIns } from '../bareClient';
import { cacheCalls } from '../cacheCalls';
import { cookieChanges, cookieStoreMethods } from '../cookieStoreMethods';
import { hookDevices } from '../deviceGrants';
import { recordSize } from '../idbSize';
import {
	dropLegacyFileSystem,
	partitionLegacyFileSystem,
} from '../legacyFileSystem';
import NavigatorIdentityModule from '../modules/NavigatorIdentity';
import { originFrom } from '../originFrom';
import {
	gateCall,
	gateGetter,
	notificationParts,
	permissionElements,
} from '../permissionGates';
import { readers as positionReaders } from '../positionMaps';
import { madeReport, observerCalls, reportsSeen } from '../reportsSeen';
import { bucketMethods } from '../storageBucketMethods';
import { storageUsage } from '../storageUsage';
import { carry as carryWebTransport } from '../webTransport';
import { standIn as webTransportStandIn } from '../webTransportStandIn';
import { windowArrays } from '../windowArrays';
import { workerStart } from '../workerStart';
import { checkedHeader, checkedMethod, notOpened } from '../xhrChecks';
import { ancestorOriginsList } from './ancestorOriginsList';
import { animatedHref } from './animatedHref';
import { attributeViewMethods } from './attributeViewMethods';
import { relayBeacon } from './beaconRelay';
import { calledHooks } from './calledHooks';
import {
	credentialGet,
	credentialStore,
	preventSilentAccess,
} from './credentialCalls';
import {
	identityFlow,
	loginStatus,
	relyingPartyGuard,
} from './credentialFlows';
import { ownStoreRefusal } from './credentialStore';
import { installDeviceIds } from './deviceIds';
import { saveDownload } from './downloadSave';
import { fetchLater } from './fetchLater';
import { formSubmitted } from './formSubmissions';
import { fragmentLink } from './fragmentLinks';
import { hookHandlerName } from './handlerGetters';
import { routedImportMap } from './importMaps';
import { instructionData, loadXML, xmlProlog } from './instructions';
import { lazyFonts } from './lazyFonts';
import { formEncoding, legacyFormQuery, legacyQuery } from './legacyEncoding';
import { linkOpens } from './linkOpens';
import { markupMembers } from './markupMembers';
import { codePlace, handlerPlace, markupScriptSite } from './markupPlaces';
import { markupSinks } from './markupSinks';
import { measuredMemory } from './measuredMemory';
import { artworkView, routedArtwork } from './mediaArtwork';
import { moduleGraph } from './moduleGraph';
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
import { javascriptDocument, navigationNavigate } from './navigateCalls';
import { mayNavigate, navigateOther, navigationRefused } from './navigateOther';
import { navigationRefusal, precommitRedirect } from './navigationRefusal';
import { objectLoads } from './objectLoads';
import { openerFacts, opensWithoutOpener } from './openerFacts';
import { pictureWindows } from './pictureWindows';
import { policyChecks } from './policyChecks';
import { presentationIds } from './presentations';
import { protocolHandler } from './protocolHandlers';
import { metaRefresh, opaqueDocument, reportBase } from './rareAttributes';
import { opaqueRefusal, viewportSegments } from './rareReads';
import { rtcInstall } from './rtcInstall';
import { seenImages } from './seenImages';
import {
	acceptAcross,
	ancestorAcross,
	blankLink,
	blankSubmission,
	linkAimed,
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
import { syncAnswer } from './syncAnswer';
import { syncRelay } from './syncRelay';
import {
	exportRefusal,
	textureRefusal,
	videoFrameRefusal,
} from './taintRefusals';
import { uncontrolledCopies } from './uncontrolledCopies';
import { viewTransitionCall } from './viewTransitions';
import { deliverReport } from './violationDelivery';
import {
	dispatchViolation,
	evalError,
	markupBaseSite,
	noteBaseSite,
	noteFormSite,
	refusedTrustedPolicy,
	trustedTypeError,
	violationSample,
	violationShows,
	violationURL,
} from './violations';
import { windowOpen } from './windowOpen';
import { writeStream } from './WriteStream';
import { xhrMessage } from './xhrMessages';
import { responseParser } from './xhrParse';

export const parts = {
	// the codec module's bytes, at a top's first seal (../../wasm/codecBytes.ts;
	// ../../wasm/codec.ts), and the instance made of them
	// (../../wasm/codecInstance.ts)
	codecBytes,
	codecInstance,
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
	// what a page's add(), addAll() and caches.match() do past their hooks'
	// checks, at a realm's first (../cacheCalls.ts; ../modules/Partition.ts)
	cacheCalls,
	// the reader of the maps of rewrites, at a realm's first position of
	// one: a script file's, and code's the inject rewrote, which it finds by
	// the script V8 ran (../positionMaps.ts; ../positionParts.ts)
	positionReaders,
	// where the markup has a script or a handler V8 counts a frame's line
	// and column from (./markupPlaces.ts; Client.ts rewriteInlineScripts,
	// modules/DOMAttributes.ts)
	codePlace,
	handlerPlace,
	// what a tainted source's refusals say (a WebGL texture, a VideoFrame, an
	// OffscreenCanvas's export), at a document's first (./taintRefusals.ts;
	// modules/CanvasTaint.ts)
	textureRefusal,
	videoFrameRefusal,
	exportRefusal,
	// what Origin.from() answers a page, at a realm's first call
	// (../originFrom.ts; ../modules/OriginFrom.ts)
	originFrom,
	// what reads a window as an array method or a list of arguments does,
	// at a document's first such call (../windowArrays.ts;
	// ../modules/Reflection.ts)
	windowArrays,
	// the un-routing of ReportingObserver's reports, at the first
	// (../reportsSeen.ts; ../modules/Unroute.ts)
	reportsSeen,
	// and what the page's ReportingObservers do past their hooks, at its
	// first (../reportsSeen.ts; ../modules/Unroute.ts)
	observerCalls,
	// the reports of the violations the inject makes itself, at the first
	// (../reportsSeen.ts; ./policyChecks.ts)
	madeReport,
	// and the delivery of a violation's report to the page's policy's
	// report-uri, at a document's first (./violationDelivery.ts;
	// ./policyChecks.ts, ./violations.ts)
	deliverReport,
	// what a worker's construction does past its checks, at a document's
	// first (../workerStart.ts; ../modules/Worker.ts)
	workerStart,
	compileFilter,
	proceduralRunner,
	// what measureUserAgentSpecificMemory() answers the page, at its first
	// call (./measuredMemory.ts; ./modules/Isolation.ts)
	measuredMemory,
	// whether a URL matches a source list of the page's policy, at the first
	// check one of them governs (../../cspSources.ts; Client.ts
	// pageRefusals, baseRefused, metaPolicy)
	sourcesMatch,
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
	// the configured user-agent identity's hooks, at a document whose
	// controller set one (../modules/NavigatorIdentity.ts; modules.ts)
	NavigatorIdentityModule,
	// a document's device ids and the hooks that show them, when its
	// permission hooks are installed (./deviceIds.ts; modules/Permissions.ts)
	installDeviceIds,
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
	// an SVG animation of an href, its values routed, at a document's first
	// (./animatedHref.ts; modules/DOMAttributes.ts)
	animatedHref,
	// a document's navigation of another window, refused as Chrome refuses
	// it, at its first (./navigateOther.ts; modules/Context.ts)
	navigateOther,
	// a form's submission, told to the worker and judged by the page's
	// form-action, at a document's first (./formSubmissions.ts;
	// modules/NavigationHint.ts)
	formSubmitted,
	// a link a click opens in a new browsing context, as a host tab or a
	// sandboxed popup, at a document's first (./linkOpens.ts; modules/Open.ts)
	linkOpens,
	// navigator.credentials.get() where STomp is no passkey provider,
	// store() and preventSilentAccess(), at a document's first call of one
	// (./credentialCalls.ts; modules/Credentials.ts)
	credentialGet,
	credentialStore,
	preventSilentAccess,
	// a media session's artwork, routed as the page sets it and read back
	// as the page's, at a document's first (./mediaArtwork.ts;
	// modules/MediaSession.ts)
	routedArtwork,
	artworkView,
	// the document a javascript: URL's markup becomes (DocumentClient
	// javascriptDocument) and navigation.navigate() (modules/History.ts),
	// at a document's first of either (./navigateCalls.ts)
	javascriptDocument,
	navigationNavigate,
	// a link to a fragment of this document, clicked, at a document's
	// first (./fragmentLinks.ts; modules/Fragment.ts)
	fragmentLink,
	// window.viewport.segments as a top-level page reads it
	// (modules/Framing.ts) and the SecurityErrors of an opaque document's
	// storage, cookies, caches, service workers and IndexedDB
	// (modules/Sandbox.ts, modules/ServiceWorker.ts), at a document's first
	// (./rareReads.ts)
	viewportSegments,
	opaqueRefusal,
	// and whether a sandboxed document may navigate another window, with the
	// SecurityError it gets when it may not, at its first such navigation
	// (DocumentClient.mayNavigate; modules/Sandbox.ts)
	mayNavigate,
	navigationRefused,
	// an <object>'s data and an <embed>'s src, copied through the proxy, at
	// a document's first object or embed with a URL (./objectLoads.ts;
	// ./modules/DOMAttributes.ts)
	objectLoads,
	// the copies a document no service worker controls makes of its loads,
	// at its first (./uncontrolledCopies.ts; ./modules/DOMAttributes.ts)
	uncontrolledCopies,
	// and the module graphs of such a document, at its first module
	// (./moduleGraph.ts; Client.ts importIn, moduleText)
	moduleGraph,
	// a synchronous request's answer, asked for with one of the page's own
	// where the browser lets the worker answer it, at a document's first wait
	// on the bridge (./syncAnswer.ts; modules/Sync.ts)
	syncAnswer,
	// a page's own synchronous request where no answer of the bridge can
	// come, sent to the host, at its first (./syncRelay.ts; modules/Sync.ts)
	syncRelay,
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
	violationSample,
	// and where a base or a form a violation may name was set or
	// submitted, at a document's first its policy refuses (./violations.ts;
	// modules/DOMAttributes.ts, modules/NavigationHint.ts, Client.ts
	// loadHTML)
	noteBaseSite,
	noteFormSite,
	markupBaseSite,
	// where a script of the markup a violation names is (./markupPlaces.ts;
	// ./policyChecks.ts)
	markupScriptSite,
	// the page's own policy's checks of its code and of the loads no worker
	// sees, at the first a document with a policy needs (./policyChecks.ts;
	// Client.ts), and a data: URL's integrity, which shares their digests
	// (../../sriDigest.ts; modules/DOMAttributes.ts)
	policyChecks,
	// the getters of a handler property the page's attributes use, at the
	// first attribute of its name (./handlerGetters.ts;
	// modules/DOMAttributes.ts)
	hookHandlerName,
	dataIntegrity,
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
	// and navigator.login.setStatus(), at a document's first call
	loginStatus,
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
	// and the rare branches of DOMAttributes' hooks, with the HTML shell's
	// group: a data: frame's document, a refresh meta, a report-only
	// base-uri's report (./rareAttributes.ts; modules/DOMAttributes.ts)
	opaqueDocument,
	metaRefresh,
	reportBase,
	ownStoreRefusal,
	targetAcross,
	navigateAcross,
	acceptAcross,
	ancestorAcross,
	locationAcross,
	// a link or a form aimed at another window (its target `_top`,
	// `_parent`, `_unfencedtop` or a name), at a document's first
	// (modules/Sandbox.ts; modules/IFrame.ts, a frame still on its initial
	// about:blank)
	linkAimed,
	submitAimed,
	blankLink,
	blankSubmission,
	judgeAcross,
	receiveAcross,
	onOwnSlot,
	slotContainerPolicy,
	seenImages,
	// document.startViewTransition()'s checks of a frame's viewport, at a
	// page's first call (./viewTransitions.ts; modules/ViewTransition.ts)
	viewTransitionCall,
	// a page's import map, its integrity told and its targets routed, at a
	// document's first (./importMaps.ts; Client.ts routedImportMap)
	routedImportMap,
	// window.open(), at a document's first call (./windowOpen.ts;
	// modules/DOMHooks.ts)
	windowOpen,
	// a called document's hooks, as its client applies (./calledHooks.ts;
	// modules/Called.ts): only such a document evaluates them
	calledHooks,
};

export type DeferredParts = typeof parts;
