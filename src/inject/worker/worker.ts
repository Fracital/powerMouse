import { createClientFactory } from '../Client';
import baseModules from '../modules';
import NavigatorIdentityModule from '../modules/NavigatorIdentity';
import WorkerClient from './Client';
import EncodedTransformModule from './modules/EncodedTransform';
import ImportScriptsModule from './modules/ImportScripts';
import WorkerLocationModule from './modules/Location';
import WorkerPermissionsModule from './modules/Permissions';
import ServiceWorkerGlobalModule from './modules/ServiceWorkerGlobal';
import XMLHttpRequestModule from './modules/XMLHttpRequest';

const createWorkerClient = createClientFactory(WorkerClient, (client) => {
	baseModules(client, NavigatorIdentityModule);
	client.addModule(ImportScriptsModule);
	client.addModule(WorkerLocationModule);
	client.addModule(XMLHttpRequestModule);
	client.addModule(WorkerPermissionsModule);
	client.addModule(EncodedTransformModule);
	// does nothing until the `sw:` route's preamble calls it
	client.addModule(ServiceWorkerGlobalModule);
});

export default createWorkerClient;
