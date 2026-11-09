import { IDBPDatabase, openDB } from 'idb';
import { encodeCookie } from '../encodeCookie';
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
	/** changes with every write, so a value read in parts is one value */
	tag?: string;
}

/** what an entry counts against the quota, as Chrome counts it */
const sizeOf = (item: string, value: string) => item.length + value.length;

/**
 * The most of a value one synchronous read answers, as the bridge encodes it.
 * The answer rides in cookies of 4000 characters, and Chrome keeps about 180
 * cookies per host: a value of about 700 KiB never arrived whole, so a larger
 * one is read in parts.
 */
const PART_BYTES = 256 * 1024;

/** what `part` costs in the bridge's cookies: JSON twice, then escaped */
const answerCost = (part: string) =>
	encodeCookie(JSON.stringify(JSON.stringify(part))).length;

/**
 * how long an operation a document sent asynchronously waits for the one
 * before it: one that never arrives (its request failed) must not hold the
 * document's later writes forever
 */
const ORDER_WAIT_MS = 10e3;

/**
 * how long any other call waits for the asynchronous operations that arrived
 * before it: a page reloaded right after a write reads it, as natively, and
 * a synchronous read must answer well inside the bridge's limit
 */
const SETTLE_WAIT_MS = 3e3;

interface Turns {
	next: number;
	waiting: Map<number, () => void>;
	/** operations of the document that arrived and are not done */
	active: number;
}

export default class Storage {
	private db: IDBPDatabase;
	private store: string;
	/** each origin's total size, counted once and kept with every write */
	private usage = new Map<string, Promise<number>>();
	/** the next operation of each document that writes asynchronously */
	private turns = new Map<string, Turns>();
	/** the asynchronous operations that arrived and are not done */
	private applying = new Set<Promise<void>>();
	constructor(db: IDBPDatabase, store: string) {
		this.db = db;
		this.store = store;
	}
	private resolveKey(origin: string, item: string) {
		return `${origin}/${item}`;
	}
	private total(origin: string): Promise<number> {
		let total = this.usage.get(origin);
		if (!total) {
			total = this.db
				.getAllFromIndex(this.store, 'origin', IDBKeyRange.only(origin))
				.then((entries: ItemEntry[]) =>
					entries.reduce(
						(sum, { item, value }) => sum + sizeOf(item, value),
						0,
					),
				);
			this.usage.set(origin, total);
			// a failed count is counted again next time
			total.catch(() => this.usage.delete(origin));
		}
		return total;
	}
	private count(origin: string, delta: number) {
		const total = this.usage.get(origin);
		if (total)
			this.usage.set(
				origin,
				total.then((sum) => sum + delta),
			);
	}
	/**
	 * The origin's size and that of each of `items` (0 for a missing one): a
	 * document decides with them whether a write is over the quota, which it
	 * must do before setItem returns.
	 */
	async getUsage(
		origin: string,
		items: string[],
	): Promise<[total: number, sizes: number[]]> {
		const total = await this.total(origin);
		const sizes: number[] = [];
		for (const item of items) {
			const value = await this.getItem(origin, item);
			sizes.push(value === undefined ? 0 : sizeOf(item, value));
		}
		return [total, sizes];
	}
	/**
	 * A part of a value from `offset`, as much as one synchronous answer
	 * carries, with the value's length and tag, or null when there is none.
	 * A reader asks again from where the part ended until it has `length`
	 * characters of one tag.
	 */
	async getItemPart(
		origin: string,
		item: string,
		offset: number,
	): Promise<{ part: string; length: number; tag: string } | null> {
		const data: ItemEntry | undefined = await this.db.getFromIndex(
			this.store,
			'key',
			this.resolveKey(origin, item),
		);
		if (!data) return null;
		let end = Math.min(data.value.length, offset + PART_BYTES);
		while (
			end - offset > 1 &&
			answerCost(data.value.slice(offset, end)) > PART_BYTES
		)
			end = offset + Math.ceil((end - offset) / 2);
		// never split a surrogate pair, which JSON would replace
		const last = data.value.charCodeAt(end - 1);
		if (
			end < data.value.length &&
			end - offset > 1 &&
			last >= 0xd800 &&
			last <= 0xdbff
		)
			end--;
		return {
			part: data.value.slice(offset, end),
			length: data.value.length,
			tag: data.tag ?? '',
		};
	}
	/**
	 * One of a document's asynchronous operations, applied in the order the
	 * document made them: its requests are sent at once (a write queued behind
	 * the answer to the one before was lost when the page unloaded first), so
	 * they can arrive and be read in any order. `base` is the oldest the
	 * document has in flight: every one before it landed, so a worker that
	 * started since waits for none of those.
	 */
	ordered(
		sender: string,
		seq: number,
		base: number,
		name: 'setItem' | 'removeItem' | 'clear',
		args: unknown[],
	): Promise<void> {
		const done = this.inTurn(sender, seq, base, name, args);
		this.applying.add(done);
		const forget = () => this.applying.delete(done);
		done.then(forget, forget);
		return done;
	}
	/** every asynchronous operation that arrived is done (or took too long) */
	async settled(): Promise<void> {
		const deadline = Date.now() + SETTLE_WAIT_MS;
		while (this.applying.size && Date.now() < deadline)
			await Promise.race([
				Promise.allSettled([...this.applying]),
				new Promise((resolve) => setTimeout(resolve, deadline - Date.now())),
			]);
	}
	private async inTurn(
		sender: string,
		seq: number,
		base: number,
		name: 'setItem' | 'removeItem' | 'clear',
		args: unknown[],
	): Promise<void> {
		let turns = this.turns.get(sender);
		if (!turns) {
			turns = { next: base, waiting: new Map(), active: 0 };
			this.turns.set(sender, turns);
		}
		const own = turns;
		own.next = Math.max(own.next, base);
		own.active++;
		if (seq > own.next)
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					own.waiting.delete(seq);
					resolve();
				}, ORDER_WAIT_MS);
				own.waiting.set(seq, () => {
					clearTimeout(timer);
					resolve();
				});
			});
		try {
			await (this[name] as (...args: unknown[]) => Promise<void>)(...args);
		} finally {
			own.next = Math.max(own.next, seq + 1);
			const wake = own.waiting.get(own.next);
			own.waiting.delete(own.next);
			wake?.();
			// forgotten only when none is left, or a later one would start
			// from a base that is behind what was applied and wait it out
			if (!--own.active) this.turns.delete(sender);
		}
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
		await this.total(origin);
		await this.db.put(this.store, {
			item,
			value,
			origin,
			key: this.resolveKey(origin, item),
			tag: `${Date.now()}:${Math.random()}`,
		} as ItemEntry);
		this.count(
			origin,
			sizeOf(item, value) - (oldValue === null ? 0 : sizeOf(item, oldValue)),
		);
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
		if (oldValue !== null) this.count(origin, -sizeOf(item, oldValue));
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
		this.usage.set(origin, Promise.resolve(0));
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
			'getItemPart',
			'getUsage',
			'setItem',
			'removeItem',
			'getKeys',
			'clear',
			'ordered',
		]) {
			const call = host[api as keyof Storage] as (
				...args: unknown[]
			) => Promise<unknown>;
			router.routes.set(
				new RegExp(`^\\/${name}\\/${api}$`),
				jsonAPI(
					api === 'ordered'
						? call.bind(host)
						: async (...args: unknown[]) => {
								await host.settled();
								return call.apply(host, args);
							},
				),
			);
		}
	}
}
