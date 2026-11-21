import Client from '../Client';
import Module from '../Module';
import type { BucketContext, BucketMethod } from '../storageBucketMethods';
import { storageBucketParts } from '../storageBucketParts';
import ProxyModule from './Proxy';

// What the bucket names are made with, taken when the bundle is evaluated
// (before any page script): a page that could change how its own prefix
// is computed could name another site's buckets
const charCodeAt = String.prototype.charCodeAt;
const pow = Math.pow;
const Words = Int32Array;
const NativePromise = Promise;
const promiseThen = Promise.prototype.then;
const NativeMap = Map;
const NativeWeakSet = WeakSet;

type Manager = Record<'open' | 'keys' | 'delete', (...args: any[]) => any>;

/**
 * navigator.storageBuckets, per site. The browser keys buckets by the proxy
 * origin, every proxied site's together, so a site would list, open and
 * delete another's buckets and read the stores in them. Each bucket's real
 * name starts with a prefix of the context's storage key (src/partition.ts,
 * a digest the page cannot steer) and the page reads back the names it
 * gave. A name too long for the prefix (Chrome takes 63 characters) is
 * kept as a digest of its own, and the bucket holds an empty database by
 * the page's name (`#name`, which no database of the page's is: theirs end
 * in the key) for keys() to read it back. The stores inside a bucket are
 * keyed as everywhere else (the IndexedDB and Partition modules). An
 * opaque (sandboxed) document is refused the buckets, as natively. The
 * hooks are made here; what they do is ../storageBucketMethods.ts, made at
 * the realm's first call.
 */
export default class StorageBucketsModule extends Module<Client> {
	apply() {
		const client = this.client;
		const global = client.global;
		const bucketGlobals = global as unknown as {
			StorageBucketManager?: { new (): unknown; prototype: Manager };
		};
		if (typeof bucketGlobals.StorageBucketManager !== 'function') return;
		// a profile apart from the default one (src/profile.ts, Tor mode) has
		// no buckets, as a browser without the API (every one but
		// Chromium's): a bucket's real name is a digest, which tells no
		// profile, so a profile forgotten could not find its buckets
		if (client.profile) {
			for (const owner of [
				(global as { Navigator?: { prototype: object } }).Navigator,
				(global as { WorkerNavigator?: { prototype: object } }).WorkerNavigator,
			])
				if (owner) Reflect.deleteProperty(owner.prototype, 'storageBuckets');
			Reflect.deleteProperty(global, 'StorageBucketManager');
			Reflect.deleteProperty(global, 'StorageBucket');
			return;
		}
		const proxyModule = client.getModule(ProxyModule)!;
		const manager = bucketGlobals.StorageBucketManager.prototype;
		// (the factory's natives, before the IndexedDB module suffixes them)
		const factory = global.IDBFactory?.prototype as
			| (IDBFactory & { databases?: () => Promise<IDBDatabaseInfo[]> })
			| undefined;
		const isPrototypeOf = global.Object.prototype.isPrototypeOf;
		// StorageBucket's interface is left alone until a bucket is opened (a
		// frame that opens none pays nothing for it): the name of the
		// prototype of the first bucket of each realm is hooked before the
		// page has the bucket
		let named: WeakSet<object> | null = null;
		const context: BucketContext = {
			storageKey: () => client.nativeKey,
			opaque: () =>
				(client as { sandboxedOpaque?: boolean }).sandboxedOpaque === true,
			isManager: (that: unknown) =>
				typeof that === 'object' &&
				that !== null &&
				(Reflect.apply(isPrototypeOf, manager, [that]) as boolean),
			nativeOpen: manager.open,
			named: (bucket) => {
				const proto = Reflect.getPrototypeOf(bucket);
				if (!proto || (named ??= new NativeWeakSet()).has(proto)) return;
				named.add(proto);
				context.idbGet ??= Reflect.getOwnPropertyDescriptor(
					proto,
					'indexedDB',
				)?.get;
				const name = Reflect.getOwnPropertyDescriptor(proto, 'name');
				if (name?.get)
					Reflect.defineProperty(proto, 'name', {
						...name,
						get: proxyModule.wrapFunction(name.get, hook('name')),
					});
			},
			databasesOf: factory?.databases,
			openDatabase: factory?.open,
			charCodeAt,
			pow,
			Words,
			NativePromise,
			promiseThen,
			NativeMap,
			DOMException: global.DOMException,
			TypeError: global.TypeError,
		};
		let made: Record<'open' | 'keys' | 'delete' | 'name', BucketMethod> | null =
			null;
		const hook =
			(key: 'open' | 'keys' | 'delete' | 'name') =>
			(target: any, that: unknown, args: unknown[]) =>
				(made ??= storageBucketParts.methods!()(context))[key](
					target,
					that,
					args,
				);
		for (const key of ['open', 'keys', 'delete'] as const)
			manager[key] = proxyModule.wrapFunction(manager[key], hook(key));
	}
}
