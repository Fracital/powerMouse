import { createClientFactory } from '../Client';
import baseModules from '../modules';
import WorkerClient from './Client';
import ImportScriptsModule from './modules/ImportScripts';
import WorkerLocationModule from './modules/Location';
import XMLHttpRequestModule from './modules/XMLHttpRequest';

const createWorkerClient = createClientFactory(WorkerClient, (client) => {
	baseModules(client);
	client.addModule(ImportScriptsModule);
	client.addModule(WorkerLocationModule);
	client.addModule(XMLHttpRequestModule);
});

export default createWorkerClient;
