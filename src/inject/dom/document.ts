import { createClientFactory } from '../Client';
import baseModules from '../modules';
import DocumentClient from './Client';
import AnchorModule from './modules/Anchor';
import AnimationFramesModule from './modules/AnimationFrames';
import AudioModule from './modules/Audio';
import BlobDocumentsModule from './modules/BlobDocuments';
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
import FramingModule from './modules/Framing';
import HistoryModule from './modules/History';
import IFrameModule from './modules/IFrame';
import LocationModule from './modules/Location';
import MediaSessionModule from './modules/MediaSession';
import MutationObserverModule from './modules/MutationObserver';
import NavigateModule from './modules/Navigate';
import NavigationHintModule from './modules/NavigationHint';
import NavigatorModule from './modules/Navigator';
import OpenModule from './modules/Open';
import ReadbackModule from './modules/Readback';
import SandboxModule from './modules/Sandbox';
import ServiceWorkerModule from './modules/ServiceWorker';
import StorageModule from './modules/Storage';
import SyncModule from './modules/Sync';
import TokenListsModule from './modules/TokenLists';
import ViewTransitionModule from './modules/ViewTransition';
import XMLHttpRequestModule from './modules/XMLHttpRequest';

export function addClientModules(client: DocumentClient) {
	baseModules(client);
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
	client.addModule(MediaSessionModule);
	client.addModule(AnimationFramesModule);
	client.addModule(NavigateModule);
	client.addModule(NavigationHintModule);
	client.addModule(ReadbackModule);
	client.addModule(CSSReadbackModule);
	// last: the Navigate module's own observer keeps the native constructor
	client.addModule(MutationObserverModule);
}

const createDOMClient = createClientFactory(DocumentClient, addClientModules);

export default createDOMClient;
