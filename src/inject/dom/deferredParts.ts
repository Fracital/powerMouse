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
// (and the per-site legacy file system, ../legacyFileSystem.ts, at a
// realm's first call of it)
//
// (and the WebTransport stand-in, ../webTransportStandIn.ts, with what
// carries its sessions, ../webTransport.ts, once a realm makes its first
// session)
// (and what routes xml-stylesheet processing instructions and an XML
// document's prolog, ./instructions.ts, at the first one a document meets)
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
import { compileFilter } from '../../blocker/procedural';
import { noticeText } from '../../mixedContentNotices';
import { accessFailures } from '../accessFailures';
import { bareClient } from '../bareClient';
import { cookieStoreMethods } from '../cookieStoreMethods';
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
import { instructionData, modifyXML, xmlProlog } from './instructions';
import { formEncoding, legacyFormQuery, legacyQuery } from './legacyEncoding';
import { markupMembers } from './markupMembers';
import FingerprintModule from './modules/Fingerprint';
import { longFrames } from './modules/LongFrames';
import { longTasks } from './modules/LongTasks';
import {
	deviceConstraints,
	notificationCall,
	positionCall,
	userMediaCall,
} from './modules/permissionCalls';
import { emulateServiceWorker } from './modules/serviceWorkerEmulation';
import { navigateOther } from './navigateOther';
import { navigationRefusal, precommitRedirect } from './navigationRefusal';
import { openerFacts, opensWithoutOpener } from './openerFacts';
import { pictureWindows } from './pictureWindows';
import { presentationIds } from './presentations';
import { rtcInstall } from './rtcInstall';
import {
	acceptAcross,
	ancestorAcross,
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
import { writeStream } from './WriteStream';
import { xhrMessage } from './xhrMessages';
import { responseParser } from './xhrParse';

export const parts = {
	bareClient,
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
	longFrames,
	longTasks,
	cookieStoreMethods,
	relayBeacon,
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
	rtcInstall,
	responseParser,
	xhrMessage,
	emulateServiceWorker,
	markupMembers,
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
	instructionData,
	xmlProlog,
	modifyXML,
	ownStoreRefusal,
	targetAcross,
	navigateAcross,
	acceptAcross,
	ancestorAcross,
	locationAcross,
	submitAimed,
	judgeAcross,
	receiveAcross,
	onOwnSlot,
	slotContainerPolicy,
};

export type DeferredParts = typeof parts;
