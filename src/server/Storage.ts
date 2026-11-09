import { IDBPDatabase, openDB } from 'idb';
import { encodeCookie } from '../encodeCookie';
import { STORAGE_EVENT, StorageChange } from '../transport/messages';
import Router, { json, jsonAPI } from './Router';

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
 * How long any other call of an origin waits for the asynchronous operations
 * of that origin the worker heard of: a page reloaded right after a write
 * reads it, as natively, however long its body takes to arrive (the worker
 * hears of an operation from its URL, before its body: a 2 MiB value took
 * long enough on a slow runner that the reloaded page read without it). A
 * synchronous read must answer well inside the bridge's 10 s limit, so one
 * still out after this counts as lost (see `lose`).
 */
const SETTLE_WAIT_MS = 6e3;
/** after that, how long an operation already being applied is waited for */
const APPLY_WAIT_MS = 2e3;

type OrderedName = 'setItem' | 'removeItem' | 'clear';
const ORDERED_NAMES = new Set<string>(['setItem', 'removeItem', 'clear']);

/**
 * how long a document's place in its asynchronous operations is kept after
 * the last of them is done: the oldest one it names as in flight can be one
 * that landed already, because it learns of that only when its main thread
 * runs the answer, which a busy page does seconds later
 */
const TURNS_KEPT_MS = 5 * 60e3;

interface Turns {
	next: number;
	waiting: Map<number, () => void>;
	/** operations of the document that arrived and are not done */
	active: number;
	/** when the last of them was done, while none is left */
	idle: number | null;
}

/** an asynchronous operation the worker heard of and has not finished */
interface Heard {
	origin: string;
	name: OrderedName;
	/** the key it writes, or null for a clear */
	key: string | null;
	/** its turn came and its body arrived: it is being applied */
	started: boolean;
	/** given up on: its key was emptied */
	lost: boolean;
	finished: Promise<void>;
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export default class Storage {
	private db: IDBPDatabase;
	private store: string;
	/** each origin's total size, counted once and kept with every write */
	private usage = new Map<string, Promise<number>>();
	/** the next operation of each document that writes asynchronously */
	private turns = new Map<string, Turns>();
	/** the asynchronous operations the worker heard of and has not finished */
	private heard = new Set<Heard>();
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
	 * they can arrive and be read in any order. Which operation it is comes in
	 * its URL (the document's `sender`, the operation's `seq`, `base`, `name`,
	 * `origin` and `key`) and its arguments in its body: every other call of
	 * the origin waits for it from the moment its request arrives, not from
	 * when its body has been read, and one whose body never comes is known by
	 * its key. `base` is the oldest the document has in flight: every one
	 * before it landed, so a worker that started since waits for none of
	 * those.
	 */
	async ordered(request: Request): Promise<Response> {
		const params = new URL(request.url).searchParams;
		const sender = params.get('sender');
		const seq = Number(params.get('seq'));
		const base = Number(params.get('base'));
		const name = params.get('name') ?? '';
		const origin = params.get('origin');
		const key = params.get('key');
		if (
			sender === null ||
			origin === null ||
			!ORDERED_NAMES.has(name) ||
			!Number.isInteger(seq) ||
			!Number.isInteger(base) ||
			(name !== 'clear' && key === null)
		)
			return json(400, 'not an ordered storage operation');
		// read from now on, while the operation waits for its turn
		const body = request.json() as Promise<unknown[]>;
		body.catch(() => {});
		const op = {
			origin,
			name: name as OrderedName,
			key: name === 'clear' ? null : key,
			started: false,
			lost: false,
		} as Heard;
		op.finished = this.inTurn(sender, seq, base, op, body);
		this.heard.add(op);
		const forget = () => this.heard.delete(op);
		op.finished.then(forget, forget);
		try {
			await op.finished;
			return json(200, null);
		} catch (error) {
			return json(500, String(error));
		}
	}
	/**
	 * Every asynchronous operation of `origin` the worker heard of is done,
	 * or counts as lost. A reader must answer, and must not answer with a
	 * value that a write it knows of replaced, so the key of an operation
	 * still out after the wait is emptied rather than read as current; the
	 * operation is still applied if its body comes later.
	 */
	async settled(origin: string): Promise<void> {
		const deadline = Date.now() + SETTLE_WAIT_MS;
		const out = () =>
			[...this.heard].filter((op) => op.origin === origin && !op.lost);
		for (let ops = out(); ops.length && Date.now() < deadline; ops = out())
			await Promise.race([
				Promise.allSettled(ops.map((op) => op.finished)),
				sleep(deadline - Date.now()),
			]);
		// decided once: one that arrives from now on is waited for by the
		// calls after this one
		const late = out();
		await Promise.all(
			late
				.filter((op) => !op.started)
				.map((op) => this.lose(op, `not applied within ${SETTLE_WAIT_MS} ms`)),
		);
		// one being applied now is in the store in a moment
		const applying = late.filter((op) => op.started);
		if (applying.length)
			await Promise.race([
				Promise.allSettled(applying.map((op) => op.finished)),
				sleep(APPLY_WAIT_MS),
			]);
	}
	/**
	 * An operation that will not be applied in time, or ever: its key (every
	 * key, for a clear) is emptied, so no document reads the value it
	 * replaced as if it were current, and the loss is logged
	 */
	private async lose(op: Heard, why: string) {
		if (op.lost) return;
		op.lost = true;
		console.error(
			`Stomp: a ${this.store} ${op.name} of ${op.origin}${
				op.key === null ? '' : ` (key ${JSON.stringify(op.key)})`
			} was lost, ${why}; the key reads as absent`,
		);
		if (op.key === null) await this.clear(op.origin);
		else await this.removeItem(op.origin, op.key);
	}
	private async inTurn(
		sender: string,
		seq: number,
		base: number,
		op: Heard,
		body: Promise<unknown[]>,
	): Promise<void> {
		const now = Date.now();
		for (const [other, turns] of this.turns)
			if (turns.idle !== null && now - turns.idle > TURNS_KEPT_MS)
				this.turns.delete(other);
		let turns = this.turns.get(sender);
		if (!turns) {
			turns = { next: base, waiting: new Map(), active: 0, idle: null };
			this.turns.set(sender, turns);
		}
		const own = turns;
		own.next = Math.max(own.next, base);
		own.active++;
		own.idle = null;
		try {
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
			let args: unknown[];
			try {
				args = await body;
			} catch (error) {
				// the document's request ended without its body
				await this.lose(op, `its body did not arrive (${error})`);
				throw error;
			}
			op.started = true;
			await (this[op.name] as (...args: unknown[]) => Promise<void>)(...args);
		} finally {
			own.next = Math.max(own.next, seq + 1);
			const wake = own.waiting.get(own.next);
			own.waiting.delete(own.next);
			wake?.();
			// kept when none is left: Discord writes again before its page has
			// seen the last write land, from a base behind what was applied,
			// and a document started afresh waited 10 s for a write it had,
			// while every read waited 3 s for that one
			if (!--own.active) own.idle = Date.now();
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
				api === 'ordered'
					? (request) => host.ordered(request)
					: jsonAPI(async (origin: string, ...args: unknown[]) => {
							await host.settled(origin);
							return call.call(host, origin, ...args);
						}),
			);
		}
	}
}
