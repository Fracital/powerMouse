import { createClientFactory } from '../Client';
import baseModules from '../modules';
import DocumentClient from './Client';
import AnchorModule from './modules/Anchor';
import AudioModule from './modules/Audio';
import BlobDocumentsModule from './modules/BlobDocuments';
import ContextModule from './modules/Context';
import { CookiesModule } from './modules/Cookies';
import CSSOMModule from './modules/CSSOM';
import DOMAttributesModule from './modules/DOMAttributes';
import DOMContentHooks from './modules/DOMContentHooks';
import DOMHooksModule from './modules/DOMHooks';
import FramingModule from './modules/Framing';
import HistoryModule from './modules/History';
import IFrameModule from './modules/IFrame';
import LocationModule from './modules/Location';
import NavigateModule from './modules/Navigate';
import NavigatorModule from './modules/Navigator';
import OpenModule from './modules/Open';
import ReadbackModule from './modules/Readback';
import StorageModule from './modules/Storage';
import SyncModule from './modules/Sync';
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
	client.addModule(NavigateModule);
	client.addModule(ReadbackModule);
}

const createDOMClient = createClientFactory(DocumentClient, addClientModules);

export default createDOMClient;
