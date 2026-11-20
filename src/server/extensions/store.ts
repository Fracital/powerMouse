// Where the service worker keeps installed extensions (docs/extensions.md):
// each package as one blob in its own Cache Storage cache, with an index of
// its files (PackageFiles), and the records, chrome.storage (a record per
// key) and the extensions' own state (dynamic rules, registered content
// scripts) in one IndexedDB database. One store per scope: every
// controller of it sees the same extensions, as every tab of a browser
// does.
import { openDB, type IDBPDatabase } from 'idb';
import { extensionURL } from '../../extensions/origin';
import type { Manifest } from '../../extensions/types';

export const EXTENSIONS_DATABASE = 'extension-store';
export const FILE_CACHE = 'extension-files';
/** the content scripts' rewritten functions, by their route (src/server/extensions/contentScripts.ts) */
export const SCRIPT_CACHE = 'extension-scripts';

/** an installed extension as the database keeps it */
export interface StoredExtension {
	id: string;
	/** the manifest as written (not localized) */
	manifest: Manifest;
	enabled: boolean;
	policy: boolean;
	installedAt: number;
	updatedAt: number;
	source: 'package' | 'webstore' | 'unpacked';
	webStoreId: string | null;
	filename: string;
	/** every file's path */
	files: string[];
	/** where each file is in the package's blob (PackageFiles) */
	index: PackIndex;
	/** the version the background last ran (runtime.onInstalled's reason) */
	lastRunVersion?: string;
	/** bumps with every install and update: the content scripts' routes carry it */
	generation: number;
}

const TYPES: Record<string, string> = {
	html: 'text/html; charset=utf-8',
	htm: 'text/html; charset=utf-8',
	js: 'text/javascript; charset=utf-8',
	mjs: 'text/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	json: 'application/json; charset=utf-8',
	txt: 'text/plain; charset=utf-8',
	xml: 'application/xml',
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	ico: 'image/x-icon',
	bmp: 'image/bmp',
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	otf: 'font/otf',
	wasm: 'application/wasm',
	mp3: 'audio/mpeg',
	ogg: 'audio/ogg',
	wav: 'audio/wav',
	mp4: 'video/mp4',
	webm: 'video/webm',
};

/** a file's type by its extension, as Chrome serves an extension's files */
export function mimeOf(path: string): string {
	return (
		TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ??
		'application/octet-stream'
	);
}

let database: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
	database ??= openDB(EXTENSIONS_DATABASE, 1, {
		upgrade(made) {
			for (const name of ['extensions', 'storage', 'state'])
				if (!made.objectStoreNames.contains(name)) made.createObjectStore(name);
		},
	}).catch((error) => {
		database = null;
		throw error;
	});
	return database;
}

export const records = {
	all: async () =>
		(await (await db()).getAll('extensions')) as StoredExtension[],
	get: async (id: string) =>
		(await (await db()).get('extensions', id)) as StoredExtension | undefined,
	put: async (record: StoredExtension) => {
		await (await db()).put('extensions', record, record.id);
	},
	delete: async (id: string) => {
		await (await db()).delete('extensions', id);
	},
};

/** every key of a store that starts with `prefix` */
const under = (prefix: string) => IDBKeyRange.bound(prefix, `${prefix}￿`);

/**
 * chrome.storage's local, sync and managed areas (session is the worker's
 * memory): one record per key (`<id>:<area>:<key>`), so a set writes what
 * it sets however much else the area holds, and its promise resolves once
 * the transaction committed
 */
export const storageAreas = {
	async get(id: string, area: string): Promise<Record<string, unknown>> {
		const store = (await db()).transaction('storage').store;
		const prefix = `${id}:${area}:`;
		const [keys, values] = await Promise.all([
			store.getAllKeys(under(prefix)),
			store.getAll(under(prefix)),
		]);
		const data: Record<string, unknown> = {};
		keys.forEach((key, index) => {
			data[String(key).slice(prefix.length)] = values[index];
		});
		return data;
	},
	/** write `set` and delete `removed` (every key with `clear`), in one transaction */
	async apply(
		id: string,
		area: string,
		set: Record<string, unknown>,
		removed: string[],
		clear = false,
	) {
		const transaction = (await db()).transaction('storage', 'readwrite');
		const prefix = `${id}:${area}:`;
		if (clear) void transaction.store.delete(under(prefix));
		else
			for (const key of removed)
				void transaction.store.delete(`${prefix}${key}`);
		for (const [key, value] of Object.entries(set))
			void transaction.store.put(value, `${prefix}${key}`);
		await transaction.done;
	},
	forget: async (id: string) => {
		await (await db()).delete('storage', under(`${id}:`));
	},
};

/** an extension's own state (dynamic rules, enabled rulesets, registered scripts) */
export const extensionState = {
	get: async (id: string, key: string) =>
		(await db()).get('state', `${id}:${key}`) as Promise<unknown>,
	put: async (id: string, key: string, value: unknown) => {
		await (await db()).put('state', value, `${id}:${key}`);
	},
	forget: async (id: string) => {
		await (await db()).delete('state', under(`${id}:`));
	},
};

/**
 * Where a file of a package is in its blob: `[at, size, length, method]`,
 * the stored bytes' offset and size, the file's own length, and 0 (stored)
 * or 8 (deflate), as in the package's ZIP
 */
export type PackedFile = [number, number, number, number];

/** a package's files' index, by path */
export type PackIndex = Record<string, PackedFile>;

/** each extension's own Cache Storage cache: its package is one entry of it */
const fileCache = (id: string) => `${FILE_CACHE}:${id}`;
/** each extension's rewritten content scripts (contentScripts.ts, api.ts) */
export const scriptCache = (id: string) => `${SCRIPT_CACHE}:${id}`;
const packageURL = (id: string) => extensionURL(id, '.archive');

async function inflated(data: Blob, length: number): Promise<Uint8Array> {
	const stream = data
		.stream()
		.pipeThrough(new DecompressionStream('deflate-raw'));
	const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
	return bytes.length === length ? bytes : bytes.subarray(0, length);
}

/**
 * An extension's files: its package as one blob in Cache Storage (the ZIP
 * as it came, or an unpacked extension's files end to end) and an index of
 * where each file is in it, so an install is one put however many files the
 * package has (Wappalyzer's 13,346), a removal is one cache's deletion, and
 * a file is inflated when something reads it. The blob the cache gives is
 * the disk's: a file's read is a slice of it.
 */
class PackageFiles {
	#blobs = new Map<string, Promise<Blob | null>>();
	#indexes = new Map<string, PackIndex>();
	/** an extension's package and its index (an install, an update) */
	async write(id: string, pack: Blob, index: PackIndex) {
		this.#blobs.delete(id);
		const cache = await caches.open(fileCache(id));
		await cache.put(
			packageURL(id),
			new Response(pack, { headers: { 'content-type': 'application/zip' } }),
		);
		this.#indexes.set(id, index);
	}
	/** the index of an extension the worker loads (its record's) */
	attach(id: string, index: PackIndex) {
		this.#indexes.set(id, index);
	}
	#blob(id: string): Promise<Blob | null> {
		let blob = this.#blobs.get(id);
		if (!blob) {
			blob = caches
				.open(fileCache(id))
				.then((cache) => cache.match(packageURL(id)))
				.then((response) => response?.blob() ?? null)
				.catch(() => null);
			this.#blobs.set(id, blob);
		}
		return blob;
	}
	/** one file's bytes, or null when the package has no such file */
	async bytes(id: string, path: string): Promise<Uint8Array | null> {
		const index = this.#indexes.get(id);
		const entry = index && Object.hasOwn(index, path) ? index[path] : undefined;
		if (!entry) return null;
		const blob = await this.#blob(id);
		if (!blob) return null;
		const [at, size, length, method] = entry;
		const data = blob.slice(at, at + size);
		if (method === 8) return inflated(data, length);
		return new Uint8Array(await data.arrayBuffer());
	}
	async read(id: string, path: string): Promise<Response | null> {
		const bytes = await this.bytes(id, path);
		if (!bytes) return null;
		return new Response(bytes as Uint8Array<ArrayBuffer>, {
			headers: {
				'content-type': mimeOf(path),
				'content-length': String(bytes.byteLength),
			},
		});
	}
	async text(id: string, path: string): Promise<string | null> {
		const bytes = await this.bytes(id, path);
		return bytes ? new TextDecoder().decode(bytes) : null;
	}
	/** an extension's package and the content scripts rewritten from it */
	async remove(id: string) {
		this.#blobs.delete(id);
		this.#indexes.delete(id);
		await caches.delete(fileCache(id));
		await caches.delete(scriptCache(id));
	}
}

export const files = new PackageFiles();
