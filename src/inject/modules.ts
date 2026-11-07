import Client from './Client';
import AccessModule from './modules/Access';
import ConsoleModule from './modules/Console';
import FetchModule from './modules/Fetch';
import FunctionModule from './modules/Function';
import IndexedDBModule from './modules/IndexedDB';
import ObjectURLModule from './modules/ObjectURL';
import PartitionModule from './modules/Partition';
import ProxyModule from './modules/Proxy';
import ReflectionModule from './modules/Reflection';
import TimersModule from './modules/Timers';
import UnrouteModule from './modules/Unroute';
import WebSocketModule from './modules/WebSocket';
import WorkerModule from './modules/Worker';

export default function baseModules(client: Client) {
	client.addModule(ProxyModule);
	client.addModule(FetchModule);
	client.addModule(ObjectURLModule);
	client.addModule(AccessModule);
	client.addModule(ReflectionModule);
	client.addModule(FunctionModule);
	client.addModule(TimersModule);
	client.addModule(WorkerModule);
	client.addModule(IndexedDBModule);
	client.addModule(PartitionModule);
	client.addModule(WebSocketModule);
	client.addModule(UnrouteModule);
	client.addModule(ConsoleModule);
}
