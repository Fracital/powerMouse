import { IDBPDatabase, openDB } from 'idb';
import { STORAGE_EVENT, StorageChange } from '../transport/messages';
import Router, { jsonAPI } from './Router';

declare const clients: Clients | undefined;

/** tell every window about a change; each document decides if it cares */
async function broadcast(change: StorageChange) {
	if (typeof clients === 'undefined') return;
	const windows = await clients.matchAll({
		type: 'window',
		includeUncontrolled: true,
	});
	for (const client of windows) client.postMessage({ [STORAGE_EVENT]: change });
}

interface ItemEntry {
	item: string;
	value: string;
	origin: string;
	key: string;
}

export default class Storage {
	private db: IDBPDatabase;
	private store: string;
	constructor(db: IDBPDatabase, store: string) {
		this.db = db;
		this.store = store;
	}
	private resolveKey(origin: string, item: string) {
		return `${origin}/${item}`;
	}
	async getItem(origin: string, item: string): Promise<string | undefined> {
		const data: ItemEntry | undefined = await this.db.getFromIndex(
			this.store,
			'key',
			this.resolveKey(origin, item),
		);

		if (data) {
			return data.value;
		} else {
			return undefined;
		}
	}
	async setItem(
		origin: string,
		item: string,
		value: string,
		sender?: string,
		url?: string,
	): Promise<void> {
		const oldValue = (await this.getItem(origin, item)) ?? null;
		await this.db.put(this.store, {
			item,
			value,
			origin,
			key: this.resolveKey(origin, item),
		} as ItemEntry);
		if (oldValue !== value)
			broadcast({
				store: this.store,
				origin,
				key: item,
				oldValue,
				newValue: value,
				sender,
				url,
			});
	}
	async removeItem(
		origin: string,
		item: string,
		sender?: string,
		url?: string,
	): Promise<void> {
		const oldValue = (await this.getItem(origin, item)) ?? null;
		await this.db.delete(this.store, this.resolveKey(origin, item));
		if (oldValue !== null)
			broadcast({
				store: this.store,
				origin,
				key: item,
				oldValue,
				newValue: null,
				sender,
				url,
			});
	}
	async getKeys(origin: string): Promise<string[]> {
		return (
			await this.db.getAllFromIndex(
				this.store,
				'origin',
				IDBKeyRange.only(origin),
			)
		).map(({ item }: ItemEntry) => item);
	}
	async clear(origin: string, sender?: string, url?: string): Promise<void> {
		const keys = await this.getKeys(origin);
		for (const key of keys)
			await this.db.delete(this.store, this.resolveKey(origin, key));
		if (keys.length)
			broadcast({
				store: this.store,
				origin,
				key: null,
				oldValue: null,
				newValue: null,
				sender,
				url,
			});
	}
}

/** the two stores a scope's controllers share */
export interface StorageHosts {
	localStorage: Storage;
	sessionStorage: Storage;
}

/**
 * The storage partitions, opened once per scope (createServer shares them
 * between the controllers of a scope). sessionStorage is wiped on open: the
 * worker's lifetime stands in for the session.
 */
export async function openStorage(): Promise<StorageHosts> {
	const db = await openDB('stompStorage', 1, {
		upgrade: (db: IDBPDatabase) => {
			for (const name of ['localStorage', 'sessionStorage']) {
				const storage = db.createObjectStore(name, {
					keyPath: 'key',
				});

				storage.createIndex('origin', 'origin');
				storage.createIndex('key', 'key');
			}
		},
	});

	db.clear('sessionStorage');

	return {
		localStorage: new Storage(db, 'localStorage'),
		sessionStorage: new Storage(db, 'sessionStorage'),
	};
}

/** the page-facing routes of a server, over the scope's stores */
export function registerStorage(router: Router, hosts: StorageHosts) {
	const register: [name: string, host: Storage][] = [
		['sessionStorage', hosts.sessionStorage],
		['localStorage', hosts.localStorage],
	];

	for (const [name, host] of register) {
		for (const api of [
			'getItem',
			'setItem',
			'removeItem',
			'getKeys',
			'clear',
		]) {
			router.routes.set(
				new RegExp(`^\\/${name}\\/${api}$`),
				jsonAPI(host[api as keyof Storage].bind(host)),
			);
		}
	}
}
