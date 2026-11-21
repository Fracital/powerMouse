// A StorageAccessHandle's members, a deferred part of the document bundle
// (./deferredParts.ts), hooked at a realm's first handle (the Storage module
// hooks requestStorageAccess and takes what this needs before any page
// script ran; this hooks the members of the handle's prototype, which has no
// interface object, before the page has the handle).
//
// Natively, document.requestStorageAccess({ ... }) in a frame resolves a
// handle whose members are its origin's unpartitioned storage: the site's
// first-party localStorage, sessionStorage, IndexedDB, Cache Storage, Web
// Locks, origin private file system, quota estimate, blob: URLs,
// BroadcastChannel and SharedWorker (measured in Chrome 157: in a frame of
// another site with partitioning on, the handle reads what a top-level page
// of the site stored and the frame's own stores do not). The browser's
// handle is of the proxy origin, every proxied site's and STomp's own stores
// at once. So each member asks the browser's first, for its checks (a type
// not requested is the browser's SecurityError, an argument it refuses its
// TypeError) and then hands out STomp's store of the site's first-party key
// (its origin alone, src/partition.ts) in its place: the Storage module's
// area of that key, the handle's own native IndexedDB, Cache Storage and
// Web Locks objects working on the window's stores under that key
// (../storageRedirect.ts), and the window's constructors and URL methods
// made under the first-party key (`client.firstParty`).
//
// This file's top level reads no global (it may be evaluated after page
// scripts ran).
import ProxyModule from '../modules/Proxy';
import { storageRedirects } from '../storageRedirect';
import type DocumentClient from './Client';

type Fn = (...args: any[]) => any;

/** what a handle's members stand for, taken before any page script ran */
export interface StorageAccessTaken {
	/** the Storage module's area of a store under a key */
	area: (store: string, key: string) => object;
	/** the window's getters of its stores (indexedDB, caches, locks) */
	stores: Record<string, Fn | undefined>;
	navigator: Navigator;
	storage: StorageManager | undefined;
	estimate: Fn | undefined;
	getDirectory: Fn | undefined;
	createObjectURL: Fn;
	revokeObjectURL: Fn;
	BroadcastChannel: Function | undefined;
	SharedWorker: Function | undefined;
}

/** what stands for the window's StorageManager in a handle's estimate() and getDirectory() */
const managers = new WeakMap<object, object>();
/** the prototypes whose members are hooked, each with its natives */
const prototypes = new WeakMap<object, Record<string, Fn>>();

/**
 * The browser's handle, once the members of its prototype are hooked (at
 * the first handle of its realm)
 */
export function storageAccessHandle(
	client: DocumentClient,
	taken: StorageAccessTaken,
	handle: object,
): object {
	const prototype = Reflect.getPrototypeOf(handle);
	if (!prototype || prototypes.has(prototype)) return handle;
	const natives: Record<string, Fn> = {};
	prototypes.set(prototype, natives);
	const proxyModule = client.getModule(ProxyModule)!;
	for (const name of Reflect.ownKeys(prototype)) {
		const descriptor = Reflect.getOwnPropertyDescriptor(prototype, name)!;
		const member = descriptor.get ?? descriptor.value;
		if (name === 'constructor' || typeof member !== 'function') continue;
		natives[name as string] = member;
		Reflect.defineProperty(prototype, name, {
			...descriptor,
			[descriptor.get ? 'get' : 'value']: proxyModule.wrapFunction(
				member,
				(target, that, args) =>
					storageAccessMember(
						client,
						taken,
						natives,
						name as string,
						target,
						that,
						args,
					),
			),
		});
	}
	return handle;
}

/**
 * The member `name` of a handle, the browser's `target` with the
 * receiver `that`: what it is natively, of the site's first-party storage
 */
function storageAccessMember(
	client: DocumentClient,
	taken: StorageAccessTaken,
	natives: Record<string, Fn>,
	name: string,
	target: Fn,
	that: object,
	args: unknown[],
): unknown {
	const key = client.url.url.origin;
	// what the handle's native stores are named by (src/profile.ts)
	const native = client.firstPartyNativeKey;
	const global = client.global;
	switch (name) {
		case 'localStorage':
		case 'sessionStorage':
			Reflect.apply(target, that, args);
			return taken.area(name, key);
		case 'indexedDB':
		case 'caches':
		case 'locks': {
			const own = Reflect.apply(target, that, args) as object;
			const getter = taken.stores[name];
			if (own && getter)
				storageRedirects.set(own, [
					Reflect.apply(
						getter,
						name === 'locks' ? taken.navigator : global,
						[],
					),
					native,
				]);
			return own;
		}
		case 'estimate':
		case 'getDirectory':
			return (async () => {
				await Reflect.apply(target, that, args);
				let manager = managers.get(that);
				if (!manager) {
					managers.set(that, (manager = {}));
					storageRedirects.set(manager, [taken.storage!, native]);
				}
				return Reflect.apply(taken[name]!, manager, []);
			})();
		case 'createObjectURL': {
			// the browser's own URL checks the argument, and goes at once
			Reflect.apply(natives.revokeObjectURL, that, [
				Reflect.apply(target, that, args),
			]);
			return Reflect.apply(taken.createObjectURL, undefined, args);
		}
		case 'revokeObjectURL':
			Reflect.apply(target, that, args);
			return Reflect.apply(taken.revokeObjectURL, undefined, args);
		case 'BroadcastChannel':
			// a channel of a name nobody uses, closed at once, for the checks
			if (args.length)
				(
					Reflect.apply(target, that, [`${Math.random()}`]) as BroadcastChannel
				).close();
			else Reflect.apply(target, that, args);
			return made(client, taken.BroadcastChannel!, args);
		case 'SharedWorker':
			// an address that cannot parse fails after the browser's checks
			// and before it starts anything
			try {
				Reflect.apply(target, that, args.length ? ['http://['] : []);
			} catch (error) {
				if ((error as Error)?.name !== 'SyntaxError') throw error;
			}
			return made(client, taken.SharedWorker!, args);
	}
	return Reflect.apply(target, that, args);
}

/** an object the window's constructor makes under the first-party key */
function made(client: DocumentClient, constructor: Function, args: unknown[]) {
	client.firstParty = true;
	try {
		return Reflect.construct(constructor, args);
	} finally {
		client.firstParty = false;
	}
}
