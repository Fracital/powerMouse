import type { FpSurface } from '../../blocker/types';
import { createClientFactory } from '../Client';
import { idbSizeParts } from '../idbSizeParts';
import { legacyFileSystemParts } from '../legacyFileSystemParts';
import { mixedContentParts } from '../mixedContentParts';
import Module from '../Module';
import baseModules from '../modules';
import { storageBucketParts } from '../storageBucketParts';
import { webTransportParts } from '../webTransportParts';
import DocumentClient from './Client';
import { deferred } from './deferred';
import AdblockModule from './modules/Adblock';
import AnchorModule from './modules/Anchor';
import AnimationFramesModule from './modules/AnimationFrames';
import AudioModule from './modules/Audio';
import BlobDocumentsModule from './modules/BlobDocuments';
import CanvasTaintModule from './modules/CanvasTaint';
import ClientHintsModule from './modules/ClientHints';
import ContentSecurityModule from './modules/ContentSecurity';
import ContextModule from './modules/Context';
import { CookiesModule } from './modules/Cookies';
import CookieStoreModule from './modules/CookieStore';
import CredentialsModule from './modules/Credentials';
import CSSOMModule from './modules/CSSOM';
import CSSReadbackModule from './modules/CSSReadback';
import DOMAttributesModule from './modules/DOMAttributes';
import DOMContentHooks from './modules/DOMContentHooks';
import DOMHooksModule from './modules/DOMHooks';
import DownloadModule from './modules/Download';
import EntryTimingModule from './modules/EntryTiming';
import FormQueryModule from './modules/FormQuery';
import FragmentModule from './modules/Fragment';
import FramingModule from './modules/Framing';
import HistoryModule from './modules/History';
import IFrameModule from './modules/IFrame';
import IsolationModule from './modules/Isolation';
import LocationModule from './modules/Location';
import MediaEncryptedModule from './modules/MediaEncrypted';
import MediaSessionModule from './modules/MediaSession';
import MediaTaintModule from './modules/MediaTaint';
import MemoryModule from './modules/Memory';
import MutationObserverModule from './modules/MutationObserver';
import NavigateModule from './modules/Navigate';
import NavigationHintModule from './modules/NavigationHint';
import NavigationTimingModule from './modules/NavigationTiming';
import NavigatorModule from './modules/Navigator';
import OpenModule from './modules/Open';
import PermissionsModule from './modules/Permissions';
import ReadbackModule from './modules/Readback';
import SandboxModule from './modules/Sandbox';
import ServiceWorkerModule from './modules/ServiceWorker';
import StorageModule from './modules/Storage';
import SyncModule from './modules/Sync';
import TokenListsModule from './modules/TokenLists';
import TrustedParseModule from './modules/TrustedParse';
import ViewTransitionModule from './modules/ViewTransition';
import VisitedModule from './modules/Visited';
import WebAssemblyPolicyModule from './modules/WebAssemblyPolicy';
import WebRTCModule from './modules/WebRTC';
import XMLHttpRequestModule from './modules/XMLHttpRequest';

/**
 * The Fingerprint module (./modules/Fingerprint.ts), a deferred part of the
 * bundle (./deferred.ts): it is added only where a surface is on, which no
 * default frame has, so the frames that never farble anything do not
 * evaluate it. Made when the client applies its modules, in this one's
 * place; it has no state before that.
 */
// a document's WebTransport stand-in and what carries its sessions are
// deferred parts, evaluated with its realm's first session
webTransportParts.standIn = () => deferred('webTransportStandIn');
webTransportParts.carry = () => deferred('carryWebTransport');
idbSizeParts.recordSize = () => deferred('recordSize');
// and so are the methods behind navigator.storageBuckets' hooks
storageBucketParts.methods = () => deferred('bucketMethods');
// and the per-site legacy file system, with its first call
legacyFileSystemParts.partition = () => deferred('partitionLegacyFileSystem');
legacyFileSystemParts.drop = () => deferred('dropLegacyFileSystem');
// and the text of a mixed content notice, with a document's first notice
mixedContentParts.noticeText = () => deferred('noticeText');

class FingerprintStandIn extends Module<DocumentClient> {
	apply() {
		const Fingerprint = deferred('FingerprintModule');
		new Fingerprint(this.client).apply();
	}
}

// the surfaces the FingerprintModule handles (every surface but performanceMemory,
// which is the Memory module): the module is added only when one of these is on
const FINGERPRINT_SURFACES: FpSurface[] = [
	'canvas',
	'webgl',
	'audio',
	'fonts',
	'screen',
	'hardwareConcurrency',
	'deviceMemory',
	'mediaDevices',
	'locale',
];

export function addClientModules(client: DocumentClient) {
	// first: it takes the natives the blocker's cosmetic rules use before
	// any other module hooks them (and nothing at all with the blocker off)
	client.addModule(AdblockModule);
	baseModules(client);
	// before History and Location: it takes the native history calls
	client.addModule(FragmentModule);
	client.addModule(HistoryModule);
	client.addModule(NavigatorModule);
	// before DOMAttributes: it takes the native getComputedStyle
	client.addModule(ViewTransitionModule);
	client.addModule(CredentialsModule);
	client.addModule(LocationModule);
	client.addModule(AnchorModule);
	client.addModule(DOMAttributesModule);
	client.addModule(DOMContentHooks);
	client.addModule(CSSOMModule);
	client.addModule(DOMHooksModule);
	// after DOMHooks: wraps the property getters its hooks defined
	client.addModule(TokenListsModule);
	client.addModule(IFrameModule);
	client.addModule(SyncModule);
	client.addModule(AudioModule);
	client.addModule(BlobDocumentsModule);
	// before Storage: it reads the proxy origin's own localStorage
	client.addModule(PermissionsModule);
	client.addModule(StorageModule);
	client.addModule(XMLHttpRequestModule);
	client.addModule(CookiesModule);
	client.addModule(CookieStoreModule);
	// after Storage, Cookies and IndexedDB: an opaque document's storage throws
	client.addModule(SandboxModule);
	// Framing before Context: it needs the native MessageEvent.source getter
	client.addModule(FramingModule);
	client.addModule(ContextModule);
	// after Context: wraps the MessageEvent.source getter it defined
	client.addModule(ServiceWorkerModule);
	client.addModule(OpenModule);
	client.addModule(DownloadModule);
	// after the base modules: their lists (Unroute) are what it reads
	client.addModule(EntryTimingModule);
	// after ResourceTiming: the older interfaces serialise its getters
	client.addModule(NavigationTimingModule);
	// before CanvasTaint: its canvas/webgl/audio readback hooks wrap the native
	// methods, and CanvasTaint's taint check then wraps those, so a tainted
	// canvas throws before anything is farbled. Added only when a farbling or
	// limiting surface is active for this host (every one is opt-in, off by
	// default), so a default frame installs nothing and pays no heap.
	if (
		FINGERPRINT_SURFACES.some((surface) => client.emulatesFingerprint(surface))
	)
		client.addModule(FingerprintStandIn);
	client.addModule(CanvasTaintModule);
	client.addModule(MediaTaintModule);
	client.addModule(MediaEncryptedModule);
	client.addModule(MediaSessionModule);
	client.addModule(IsolationModule);
	// STomp's per-site performance.memory (the `performanceMemory` surface, on
	// by default so a frame does not read the shared process heap of the page
	// that embeds it). Gated like every surface: one array check, and the module
	// (and its heap) is left out entirely when the host turned it off.
	if (client.emulatesFingerprint('performanceMemory'))
		client.addModule(MemoryModule);
	client.addModule(WebRTCModule);
	client.addModule(AnimationFramesModule);
	client.addModule(NavigateModule);
	client.addModule(NavigationHintModule);
	// after NavigationHint, whose FormData of a submission comes before it arms
	client.addModule(FormQueryModule);
	client.addModule(ClientHintsModule);
	client.addModule(VisitedModule);
	client.addModule(ContentSecurityModule);
	client.addModule(WebAssemblyPolicyModule);
	client.addModule(TrustedParseModule);
	client.addModule(ReadbackModule);
	client.addModule(CSSReadbackModule);
	// last: the Navigate module's own observer keeps the native constructor
	client.addModule(MutationObserverModule);
}

const createDOMClient = createClientFactory(DocumentClient, addClientModules);

export default createDOMClient;
