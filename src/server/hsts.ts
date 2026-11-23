import type { IDBPDatabase } from 'idb';
import { openStoreDB } from '../storeDB';
import { HSTS_DATABASE, HSTS_STORE, type JarDB } from './jarDB';

/**
 * HTTP Strict Transport Security (RFC 6797) as Chrome keeps it. The
 * browser never sees a site's Strict-Transport-Security (filterHeaders: it
 * would pin the proxy's own host), so the worker keeps it: a secure answer
 * of a host that is not an IP literal sets or renews the host (max-age, at
 * most a year as Chrome caps it, and includeSubDomains), max-age=0 forgets
 * it, and an http URL of a kept host (or of a subdomain, under
 * includeSubDomains) is fetched over https before it goes out (rewrites.ts
 * forward, and a ws: handshake as wss:, the controller's
 * #handshakeHeaders), port 80 becoming 443 as Chrome's internal redirect
 * makes it.
 *
 * Unlike Chrome's one store for the profile, each network partition
 * (src/transport/networkPartition.ts: the top-level site, and whether the
 * context is cross-site to it) keeps its own, as the connections, the TLS
 * sessions and HTTP/3's alt-svc are kept: a host's HSTS bit is a
 * cross-site identifier otherwise (one site sets it for some hosts, another
 * reads which of them load over https). No preload list is bundled: a host
 * is upgraded only after one of its own answers in that partition.
 *
 * Kept in IndexedDB beside the worker's other stores (`stompHsts`, in the
 * realm's profile); a slot of the site pool keeps it in the host origin's
 * database over the jar's port (src/server/jarDB.ts), as the permission
 * states are, so every slot's worker upgrades the same hosts.
 */

/** Chrome's ceiling on max-age (net/http/http_security_headers.cc kMaxHSTSAgeSecs): a year */
const MAX_AGE_SECONDS = 86400 * 365;
/**
 * how far a renewed expiry may move before it is written again: sites send
 * the header with every answer, and each would be a write
 */
const RENEW_MS = 3600_000;

/** a host a partition keeps */
export interface HstsHost {
	/** the network partition (networkPartitionName) */
	partition: string;
	/** the host, lowercase, without a trailing dot */
	host: string;
	/** when it expires (ms since the epoch) */
	expires: number;
	/** includeSubDomains */
	subdomains: boolean;
}

/** what a Strict-Transport-Security field says */
export interface HstsDirectives {
	/** seconds, capped at a year; 0 forgets the host */
	maxAge: number;
	includeSubDomains: boolean;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * A Strict-Transport-Security field as Chrome parses it (ParseHSTSHeader):
 * `;`-separated directives, empty ones allowed, names without case, a
 * value a token or a quoted string; max-age exactly once, digits only;
 * includeSubDomains at most once and without a value; any other directive
 * ignored. Null when the field is not valid (it is then ignored whole), as
 * is a field sent twice (the two joined with a comma make no valid max-age).
 */
export function parseHsts(value: string | null): HstsDirectives | null {
	if (value === null) return null;
	let maxAge: number | null = null;
	let includeSubDomains = false;
	for (const part of value.split(';')) {
		const directive = part.trim();
		if (!directive) continue;
		const equals = directive.indexOf('=');
		const name = (equals === -1 ? directive : directive.slice(0, equals))
			.trim()
			.toLowerCase();
		let given: string | null =
			equals === -1 ? null : directive.slice(equals + 1).trim();
		if (!TOKEN.test(name)) return null;
		if (given !== null) {
			const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(given);
			if (quoted) given = quoted[1].replace(/\\(.)/g, '$1');
			else if (!TOKEN.test(given)) return null;
		}
		if (name === 'max-age') {
			if (maxAge !== null || given === null || !/^\d+$/.test(given))
				return null;
			maxAge = Math.min(Number(given), MAX_AGE_SECONDS);
		} else if (name === 'includesubdomains') {
			if (includeSubDomains || given !== null) return null;
			includeSubDomains = true;
		}
	}
	return maxAge === null ? null : { maxAge, includeSubDomains };
}

/** the host as entries are kept: lowercase (as URL.hostname is), no trailing dot */
const canonical = (host: string) => host.toLowerCase().replace(/\.$/, '');

/** an IP literal (URL.hostname writes every IPv4 form dotted), which Chrome keeps no HSTS for */
export const ipLiteral = (host: string) =>
	host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host);

/**
 * The https URL Chrome's HSTS makes of an http (or ws) one: the scheme
 * changed and port 80 made 443 (the default, so none); any other port is
 * kept
 */
export function hstsURL(url: URL): URL {
	const secure = new URL(url.href);
	const port = secure.port;
	secure.protocol = url.protocol === 'ws:' ? 'wss:' : 'https:';
	secure.port = port === '80' ? '' : port;
	return secure;
}

let store: Promise<IDBPDatabase | null> | null = null;
/** this worker's view: every host when local, what it wrote itself when remote */
const hosts = new Map<string, HstsHost>();
let loaded: Promise<void> | null = null;
/** the site pool: a slot's worker asks the host origin's database (jarDB.ts) */
let remote: JarDB | null = null;

/** the site pool: keep the hosts in the host's database, over the jar's port */
export function useHstsRemote(db: JarDB) {
	remote = db;
}

function openStore(): Promise<IDBPDatabase | null> {
	store ??= openStoreDB(HSTS_DATABASE, 1, {
		upgrade: (db) => {
			db.createObjectStore(HSTS_STORE);
		},
	}).catch(() => null);
	return store;
}

const keyOf = (partition: string, host: string) => `${partition}\n${host}`;

const isHost = (value: unknown): value is HstsHost =>
	typeof value === 'object' &&
	value !== null &&
	typeof (value as HstsHost).partition === 'string' &&
	typeof (value as HstsHost).host === 'string' &&
	typeof (value as HstsHost).expires === 'number' &&
	typeof (value as HstsHost).subdomains === 'boolean';

function load(): Promise<void> {
	loaded ??= (async () => {
		const db = await openStore();
		if (!db) return;
		try {
			const tx = db.transaction(HSTS_STORE, 'readonly');
			const values = (await tx.store.getAll()) as unknown[];
			await tx.done;
			for (const value of values)
				if (isHost(value)) {
					const key = keyOf(value.partition, value.host);
					if (!hosts.has(key)) hosts.set(key, value);
				}
		} catch (error) {
			// no store: this worker's answers only
		}
	})();
	return loaded;
}

/** write (or, with null, drop) one host, where it is kept */
async function write(key: string, value: HstsHost | null): Promise<void> {
	if (value) hosts.set(key, value);
	else hosts.delete(key);
	try {
		if (remote) {
			if (value) await remote.put(HSTS_STORE, value, key);
			else await remote.delete(HSTS_STORE, key);
			return;
		}
		const db = await openStore();
		if (!db) return;
		if (value) await db.put(HSTS_STORE, value, key);
		else await db.delete(HSTS_STORE, key);
	} catch (error) {
		// kept for this worker's life only
	}
}

/** the entry kept for a host in a partition, unexpired */
async function entryOf(
	partition: string,
	host: string,
	now: number,
): Promise<HstsHost | null> {
	const key = keyOf(partition, host);
	let entry: HstsHost | null;
	if (remote) {
		try {
			const kept = await remote.get(HSTS_STORE, key);
			entry = isHost(kept) ? kept : null;
		} catch (error) {
			// the host's page is gone: what this worker wrote
			entry = hosts.get(key) ?? null;
		}
	} else {
		await load();
		entry = hosts.get(key) ?? null;
	}
	if (entry && entry.expires <= now) {
		await write(key, null);
		return null;
	}
	return entry;
}

/**
 * Whether an http (or ws) URL of `host` goes out over https in
 * `partition`: the host is kept, or a superdomain of it with
 * includeSubDomains (Chrome's GetDynamicSTSState walks the labels the same
 * way). Never for an IP literal.
 */
export async function hstsUpgrades(
	partition: string,
	host: string,
): Promise<boolean> {
	host = canonical(host);
	if (!host || ipLiteral(host)) return false;
	const now = Date.now();
	const labels = host.split('.');
	const entries = await Promise.all(
		labels.map((_, i) => entryOf(partition, labels.slice(i).join('.'), now)),
	);
	return entries.some((entry, i) => !!entry && (i === 0 || entry.subdomains));
}

/**
 * A response of `url` came with `field` (its Strict-Transport-Security, or
 * null) in `partition`: kept, renewed or forgotten when it came over https
 * from a host that is not an IP literal, as Chrome takes it only from a
 * secure connection (one without certificate errors: the transport fails
 * any other)
 */
export async function noteHsts(
	partition: string,
	url: URL,
	field: string | null,
): Promise<void> {
	if (field === null || url.protocol !== 'https:') return;
	const host = canonical(url.hostname);
	if (!host || ipLiteral(host)) return;
	const directives = parseHsts(field);
	if (!directives) return;
	const key = keyOf(partition, host);
	if (!remote) await load();
	if (directives.maxAge === 0) {
		// (a slot's worker cannot tell whether another slot's kept it)
		if (remote || hosts.has(key)) await write(key, null);
		return;
	}
	const next: HstsHost = {
		partition,
		host,
		expires: Date.now() + directives.maxAge * 1000,
		subdomains: directives.includeSubDomains,
	};
	const known = hosts.get(key);
	if (
		known &&
		known.subdomains === next.subdomains &&
		Math.abs(known.expires - next.expires) < RENEW_MS
	)
		return;
	await write(key, next);
}

/** forget the kept hosts `drop` says (every one without it) */
export async function forgetHsts(
	drop?: (entry: HstsHost) => boolean,
): Promise<void> {
	if (!drop) {
		hosts.clear();
		try {
			if (remote) await remote.clear(HSTS_STORE);
			else await (await openStore())?.clear(HSTS_STORE);
		} catch (error) {
			// nothing kept to clear
		}
		return;
	}
	let entries: HstsHost[];
	if (remote) {
		try {
			entries = ((await remote.getAll(HSTS_STORE)) as unknown[]).filter(isHost);
		} catch (error) {
			entries = [...hosts.values()];
		}
	} else {
		await load();
		entries = [...hosts.values()];
	}
	for (const entry of entries)
		if (drop(entry)) await write(keyOf(entry.partition, entry.host), null);
}

/**
 * Forget what HSTS keeps of a site (its registrable `domain`): its hosts in
 * every partition, and every host its partitions keep (a partition's top
 * is a site), as a site's other data is forgotten
 */
export function forgetHstsOfSite(
	domain: string,
	domainOf: (host: string) => string,
): Promise<void> {
	return forgetHsts(({ partition, host }) => {
		const top = partition.split(' ')[0];
		const at = top.indexOf('//');
		return (
			domainOf(host) === domain || (at !== -1 && top.slice(at + 2) === domain)
		);
	});
}
