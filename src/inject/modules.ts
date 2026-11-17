import Client from './Client';
import AccessModule from './modules/Access';
import ConsoleModule from './modules/Console';
import FetchModule from './modules/Fetch';
import FunctionModule from './modules/Function';
import IndexedDBModule from './modules/IndexedDB';
import MixedContentModule from './modules/MixedContent';
import ObjectURLModule from './modules/ObjectURL';
import PartitionModule from './modules/Partition';
import ProxyModule from './modules/Proxy';
import ReflectionModule from './modules/Reflection';
import ResourceBufferModule from './modules/ResourceBuffer';
import ResourceTimingModule from './modules/ResourceTiming';
import StorageBucketsModule from './modules/StorageBuckets';
import StorageEstimateModule from './modules/StorageEstimate';
import TimersModule from './modules/Timers';
import TrustedTypesModule from './modules/TrustedTypes';
import UnrouteModule from './modules/Unroute';
import WebSocketModule from './modules/WebSocket';
import WebTransportModule from './modules/WebTransport';
import WorkerModule from './modules/Worker';

export default function baseModules(client: Client) {
	client.addModule(ProxyModule);
	client.addModule(TrustedTypesModule);
	client.addModule(FetchModule);
	client.addModule(ObjectURLModule);
	client.addModule(AccessModule);
	client.addModule(ReflectionModule);
	client.addModule(FunctionModule);
	client.addModule(TimersModule);
	client.addModule(WorkerModule);
	// before the IndexedDB and Partition modules: it takes their natives
	client.addModule(StorageEstimateModule);
	client.addModule(StorageBucketsModule);
	client.addModule(IndexedDBModule);
	client.addModule(PartitionModule);
	client.addModule(MixedContentModule);
	client.addModule(WebSocketModule);
	client.addModule(WebTransportModule);
	// (before the Unroute module, which starts it)
	client.addModule(ResourceBufferModule);
	client.addModule(UnrouteModule);
	client.addModule(ResourceTimingModule);
	client.addModule(ConsoleModule);
}
