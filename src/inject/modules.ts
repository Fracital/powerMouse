import Client from './Client';
import AccessModule from './modules/Access';
import FetchModule from './modules/Fetch';
import FunctionModule from './modules/Function';
import IndexedDBModule from './modules/IndexedDB';
import PartitionModule from './modules/Partition';
import ProxyModule from './modules/Proxy';
import TimersModule from './modules/Timers';
import WebSocketModule from './modules/WebSocket';
import WorkerModule from './modules/Worker';

export default function baseModules(client: Client) {
	client.addModule(ProxyModule);
	client.addModule(FetchModule);
	client.addModule(AccessModule);
	client.addModule(FunctionModule);
	client.addModule(TimersModule);
	client.addModule(WorkerModule);
	client.addModule(IndexedDBModule);
	client.addModule(PartitionModule);
	client.addModule(WebSocketModule);
}
