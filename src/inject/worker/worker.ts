import { createClientFactory } from '../Client';
import baseModules from '../modules';
import WorkerClient from './Client';
import ImportScriptsModule from './modules/ImportScripts';
import WorkerLocationModule from './modules/Location';
import ServiceWorkerGlobalModule from './modules/ServiceWorkerGlobal';
import XMLHttpRequestModule from './modules/XMLHttpRequest';

const createWorkerClient = createClientFactory(WorkerClient, (client) => {
	baseModules(client);
	client.addModule(ImportScriptsModule);
	client.addModule(WorkerLocationModule);
	client.addModule(XMLHttpRequestModule);
	// does nothing until the `sw:` route's preamble calls it
	client.addModule(ServiceWorkerGlobalModule);
});

export default createWorkerClient;
