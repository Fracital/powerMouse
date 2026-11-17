// The host's end of the site pool's one cookie jar (src/server/jarDB.ts):
// answers every slot's service worker from the host origin's own jar
// database, the one the host's service worker opened and keeps (so the
// host's cookies API reads and clears what the slots wrote). Runs in the
// transport worker, or in the host's page when the transport lives there.
import {
	DEVICE_GRANTS_DATABASE,
	DEVICE_GRANTS_STORE,
	JAR_DATABASE,
	JAR_STORE,
	PERMISSIONS_DATABASE,
	PERMISSIONS_STORE,
	type JarCall,
	type JarChanged,
	type JarReply,
} from '../server/jarDB';

let opened: Promise<IDBDatabase> | undefined;

/**
 * The jar's database as the host's service worker made it: opened without
 * a version, so this never makes or upgrades it (the first slot is served
 * only after the host's worker answered a handshake, which opens the jar),
 * and closed for whoever does upgrade it.
 */
function database(): Promise<IDBDatabase> {
	opened ??= new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(JAR_DATABASE);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			const db = request.result;
			db.onversionchange = () => {
				db.close();
				opened = undefined;
			};
			db.onclose = () => (opened = undefined);
			if (db.objectStoreNames.contains(JAR_STORE)) resolve(db);
			else {
				db.close();
				reject(new Error('the cookie jar is not there yet'));
			}
		};
	});
	opened.catch(() => (opened = undefined));
	return opened;
}

const keptOpen = new Map<string, Promise<IDBDatabase>>();

/**
 * A store the host's service worker keeps out of line, by its database:
 * the sites' permission states and the devices they chose
 * (src/server/permissions.ts, whose version and store this makes when the
 * host's worker has not yet)
 */
function keptDatabase(name: string, storeName: string): Promise<IDBDatabase> {
	let opened = keptOpen.get(name);
	if (opened) return opened;
	opened = new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(name, 1);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(storeName))
				request.result.createObjectStore(storeName);
		};
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			const db = request.result;
			db.onversionchange = () => {
				db.close();
				keptOpen.delete(name);
			};
			db.onclose = () => keptOpen.delete(name);
			resolve(db);
		};
	});
	opened.catch(() => keptOpen.delete(name));
	keptOpen.set(name, opened);
	return opened;
}

/** the stores kept out of line, by store, and their databases */
const KEPT: Record<string, string> = {
	[PERMISSIONS_STORE]: PERMISSIONS_DATABASE,
	[DEVICE_GRANTS_STORE]: DEVICE_GRANTS_DATABASE,
};

function settled<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function answer({ op, args }: JarCall): Promise<unknown> {
	const kept = Object.hasOwn(KEPT, String(args[0]));
	const name = kept ? String(args[0]) : JAR_STORE;
	const db = await (kept ? keptDatabase(KEPT[name], name) : database());
	const write = op === 'put' || op === 'delete' || op === 'clear';
	const store = db
		.transaction(name, write ? 'readwrite' : 'readonly')
		.objectStore(name);
	switch (op) {
		case 'getAllFromIndex':
			return settled(
				store.index(String(args[1])).getAll(args[2] as IDBValidKey),
			);
		case 'getAll':
			return settled(store.getAll());
		case 'getAllKeys':
			return settled(store.getAllKeys());
		case 'get':
			return settled(store.get(args[1] as IDBValidKey));
		case 'put':
			return settled(
				kept ? store.put(args[1], String(args[2])) : store.put(args[1]),
			);
		case 'delete':
			return settled(store.delete(args[1] as IDBValidKey));
		case 'clear':
			return settled(store.clear());
		default:
			throw new Error(`not a jar request: ${String(op)}`);
	}
}

/** the ports of the slots' workers, newest last (a stopped worker's port is never heard of again) */
const ports: MessagePort[] = [];
const MAX_PORTS = 64;

/** tell every slot's worker but `except` that the jar changed for `domain` */
export function jarChanged(domain: string, except?: MessagePort) {
	for (const port of ports)
		if (port !== except)
			port.postMessage({ jarChanged: domain } satisfies JarChanged);
}

/** answer a slot's worker on `port` */
export function serveJar(port: MessagePort) {
	ports.push(port);
	for (const old of ports.splice(0, Math.max(0, ports.length - MAX_PORTS)))
		old.close();
	port.addEventListener('message', (event) => {
		const data = event.data as JarCall | JarChanged | null;
		if (typeof data !== 'object' || data === null) return;
		if ('jarChanged' in data) {
			jarChanged(String(data.jarChanged), port);
			return;
		}
		const reply = (rest: Omit<JarReply, 'jar'>) =>
			port.postMessage({ jar: data.jar, ...rest } satisfies JarReply);
		answer(data).then(
			(result) => reply({ result }),
			(error) => reply({ error: String(error) }),
		);
	});
	port.start();
}
