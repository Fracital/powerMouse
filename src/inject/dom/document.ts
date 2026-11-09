import { createClientFactory } from '../Client';
import baseModules from '../modules';
import DocumentClient from './Client';
import AnchorModule from './modules/Anchor';
import AudioModule from './modules/Audio';
import BlobDocumentsModule from './modules/BlobDocuments';
import ContextModule from './modules/Context';
import { CookiesModule } from './modules/Cookies';
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
import StorageModule from './modules/Storage';
import SyncModule from './modules/Sync';
import TokenListsModule from './modules/TokenLists';
import XMLHttpRequestModule from './modules/XMLHttpRequest';

export function addClientModules(client: DocumentClient) {
	baseModules(client);
	client.addModule(HistoryModule);
	client.addModule(NavigatorModule);
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
	// Framing before Context: it needs the native MessageEvent.source getter
	client.addModule(FramingModule);
	client.addModule(ContextModule);
	client.addModule(OpenModule);
	client.addModule(DownloadModule);
	client.addModule(MediaSessionModule);
	client.addModule(NavigateModule);
	client.addModule(NavigationHintModule);
	client.addModule(ReadbackModule);
	client.addModule(CSSReadbackModule);
	// last: the Navigate module's own observer keeps the native constructor
	client.addModule(MutationObserverModule);
}

const createDOMClient = createClientFactory(DocumentClient, addClientModules);

export default createDOMClient;
