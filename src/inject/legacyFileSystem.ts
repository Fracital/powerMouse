// The legacy sandboxed file system (webkitRequestFileSystem and its
// entries, the Sync forms in a dedicated worker), partitioned per site. The
// browser keeps one per real origin, which every proxied site shares, so
// each site (its origin and partition, Client.storageKey) gets a directory
// of its own under the real root and every path the page names is confined
// to it: paths are resolved here against the site's view (`..` stops at the
// site's root, as it stops at the real root natively) and handed to the
// browser absolute. What the page reads back is its own file system: the
// site's directory reads as the root (fullPath "/", name "", its parent
// itself), the file system is named after the site's origin and toURL()
// names it. The natives are hooked on their prototypes the first time an
// object of the kind reaches this code, before the page has one; entries of
// any other file system (a dropped file's, an input's) are left alone.
//
// The browser makes a callback's objects in the callback's realm, which is
// the bundle's, so an about:blank child the bundle injected gets objects of
// its parent's realm: what is hooked is kept by prototype, and the site an
// entry is of by its file system object, for every client of the bundle.
//
// A deferred part of the document bundle (./dom/deferred.ts), evaluated by
// a document's first call; the worker bundle carries it. Its top level
// reads no global.
import type Client from './Client';
import type ProxyModule from './modules/Proxy';

/** a URL the browser refuses as another origin's, with the words it refuses an opaque origin's request */
const UNSAFE_URL = 'filesystem:http://unsafe.invalid/temporary/';
/** the real file systems this partitions (an isolated one, a dropped file's, ends in Isolated_...) */
const SANDBOXED = /:(Temporary|Persistent)$/;
/** a toURL() of an entry under a site's directory */
const ROUTED = /^filesystem:[^/]*\/\/[^/]*\/([^/]+)\/site-[0-9a-z]+(\/.*)?$/i;

type Native = (...args: any[]) => any;
type Hook = (target: Native, that: unknown, args: unknown[]) => unknown;
interface Site {
	/** the site's directory, absolute */
	prefix: string;
	origin: string;
	/** the file system's name before its type, as Chrome writes it for the origin */
	id: string;
	/** the site's directory: the file system's root for the page */
	root: object;
}
interface State {
	/** the natives, by the prototype that had them */
	natives: WeakMap<object, Record<string, Native>>;
	patched: WeakSet<object>;
	/** the Sync forms' prototypes */
	sync: WeakSet<object>;
	/** each file system the page has, and the site it is */
	sites: WeakMap<object, Site>;
}
let state: State | undefined;

/** the site's directory name: the storage key, in letters a name never escapes */
function siteDirectory(key: string): string {
	let name = '';
	for (let i = 0; i < key.length; i++) {
		const code = key.charCodeAt(i);
		name += code < 256 ? code.toString(16).padStart(2, '0') : `u${code}`;
	}
	if (name.length <= 200) return `site-${name}`;
	// (a name has 255 bytes at most): the rest by two hashes of the key
	let a = 0x811c9dc5;
	let b = 5381;
	for (let i = 0; i < key.length; i++) {
		a = Math.imul(a ^ key.charCodeAt(i), 0x01000193) >>> 0;
		b = (Math.imul(b, 33) + key.charCodeAt(i)) >>> 0;
	}
	return `site-${name.slice(0, 180)}${a.toString(36)}z${b.toString(36)}`;
}

/** `path` resolved against `base` (absolute) as Blink resolves it, `..` stopping at the root */
function resolvePath(base: string, path: string): string {
	const parts: string[] = [];
	const all = (path.startsWith('/') ? path : `${base}/${path}`).split('/');
	for (const part of all) {
		if (part === '' || part === '.') continue;
		if (part === '..') parts.pop();
		else parts.push(part);
	}
	return `/${parts.join('/')}`;
}

/** the native `name` of an object's prototype chain (a prototype not hooked yet is as the browser made it) */
function native(object: object, name: string): Native {
	const { natives, patched } = state!;
	let proto = Reflect.getPrototypeOf(object);
	while (proto) {
		const found = natives.get(proto)?.[name];
		if (found) return found;
		if (!patched.has(proto)) {
			const descriptor = Reflect.getOwnPropertyDescriptor(proto, name);
			const own = descriptor?.get ?? descriptor?.value;
			if (typeof own === 'function') return own;
		}
		proto = Reflect.getPrototypeOf(proto);
	}
	throw new TypeError('Illegal invocation');
}
const call = (object: object, name: string, args: unknown[] = []) =>
	Reflect.apply(native(object, name), object, args);
const isSync = (object: object) => {
	let proto = Reflect.getPrototypeOf(object);
	while (proto) {
		if (state!.sync.has(proto)) return true;
		proto = Reflect.getPrototypeOf(proto);
	}
	return false;
};
/** the real file system of an entry, when it is a sandboxed one */
function systemOf(entry: unknown): object | null {
	try {
		const system = call(entry as object, 'filesystem') as object;
		return SANDBOXED.test(String(call(system, 'name'))) ? system : null;
	} catch (error) {
		return null;
	}
}
/** the site of a sandboxed entry, or null for another file system's; a sandboxed one no site has is refused */
function siteOf(entry: unknown): Site | null {
	const system = systemOf(entry);
	if (!system) return null;
	const site = state!.sites.get(system);
	if (!site) throw new TypeError('Illegal invocation');
	return site;
}
const realPath = (entry: object) => String(call(entry, 'fullPath'));
const pagePath = (site: Site, real: string) =>
	real.startsWith(`${site.prefix}/`) ? real.slice(site.prefix.length) : '/';
const callable = (value: unknown) =>
	value === undefined || typeof value === 'function';
/** the entry an operation on the site's root runs on: the real root, which refuses it in the browser's words */
const rooted = (that: unknown) => {
	const site = siteOf(that);
	return site && realPath(that as object) === site.prefix
		? call(systemOf(that)!, 'root')
		: that;
};
/** a page's path argument as the browser would take it, resolved under the site */
const confine: Hook = (target, that, args) => {
	const site = args.length ? siteOf(that) : null;
	const path = args[0];
	if (site && path !== undefined && path !== null && typeof path !== 'symbol') {
		const resolved = resolvePath(
			pagePath(site, realPath(that as object)),
			String(path),
		);
		args[0] = resolved === '/' ? site.prefix : `${site.prefix}${resolved}`;
	}
	return Reflect.apply(target, that, args);
};

const HOOKS: Record<string, Record<string, Hook>> = {
	system: {
		name: (target, that) => {
			const name = String(Reflect.apply(target, that, []));
			const kind = SANDBOXED.exec(name);
			if (!kind) return name;
			const site = state!.sites.get(that as object);
			if (!site) throw new TypeError('Illegal invocation');
			return `${site.id}:${kind[1]}`;
		},
		root: (target, that) => {
			const root = Reflect.apply(target, that, []);
			if (!SANDBOXED.test(String(call(that as object, 'name')))) return root;
			const site = state!.sites.get(that as object);
			if (!site) throw new TypeError('Illegal invocation');
			return site.root;
		},
	},
	directory: {
		getFile: confine,
		getDirectory: confine,
		removeRecursively: (target, that, args) =>
			Reflect.apply(target, rooted(that), args),
	},
	entry: {
		name: (target, that) => {
			const site = siteOf(that);
			return site && realPath(that as object) === site.prefix
				? ''
				: Reflect.apply(target, that, []);
		},
		fullPath: (target, that) => {
			const real = Reflect.apply(target, that, []);
			const site = siteOf(that);
			return site ? pagePath(site, String(real)) : real;
		},
		toURL: (target, that, args) => {
			const real = String(Reflect.apply(target, that, args));
			const site = siteOf(that);
			const match = site && ROUTED.exec(real);
			return match
				? `filesystem:${site.origin}/${match[1]}${match[2] ?? '/'}`
				: real;
		},
		getParent: (target, that, args) => {
			const site = siteOf(that);
			if (
				!site ||
				realPath(that as object) !== site.prefix ||
				!callable(args[0]) ||
				!callable(args[1])
			)
				return Reflect.apply(target, that, args);
			// the root's parent is the root, a new entry of it
			return call(
				that as object,
				'getDirectory',
				isSync(that as object)
					? [site.prefix, {}]
					: [site.prefix, {}, args[0], args[1]],
			);
		},
		moveTo: (target, that, args) => Reflect.apply(target, rooted(that), args),
		copyTo: (target, that, args) => Reflect.apply(target, rooted(that), args),
		remove: (target, that, args) => Reflect.apply(target, rooted(that), args),
	},
};

function patch(
	proxyModule: ProxyModule,
	proto: object | null,
	kind: string,
	sync: boolean,
) {
	const { natives, patched } = state!;
	if (!proto || patched.has(proto)) return;
	const own: Record<string, Native> = {};
	for (const name of [...Object.keys(HOOKS[kind]), 'filesystem']) {
		const descriptor = Reflect.getOwnPropertyDescriptor(proto, name);
		const found = descriptor?.get ?? descriptor?.value;
		if (typeof found === 'function') own[name] = found;
	}
	natives.set(proto, own);
	patched.add(proto);
	if (sync) state!.sync.add(proto);
	for (const [name, hook] of Object.entries(HOOKS[kind])) {
		const descriptor = Reflect.getOwnPropertyDescriptor(proto, name);
		if (!descriptor) continue;
		if (descriptor.get)
			Reflect.defineProperty(proto, name, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (target, that) =>
					hook(target, that, []),
				),
			});
		else if (typeof descriptor.value === 'function')
			Reflect.defineProperty(proto, name, {
				...descriptor,
				value: proxyModule.wrapFunction(descriptor.value, hook),
			});
	}
}

export function partitionLegacyFileSystem(
	client: Client,
	proxyModule: ProxyModule,
	/** the realm's own webkitResolveLocalFileSystemURL, before its hook */
	nativeResolve: Native | undefined,
): Record<string, Hook> {
	state ??= {
		natives: new WeakMap(),
		patched: new WeakSet(),
		sync: new WeakSet(),
		sites: new WeakMap(),
	};
	const { sites } = state;
	const prefix = `/${siteDirectory(client.storageKey)}`;
	const page = client.url.url;
	const id = `${page.protocol.slice(0, -1)}_${page.hostname}_${page.port || '0'}`;

	/** the native root of a file system the page is about to get, its kinds hooked */
	const nativeRoot = (system: object, sync: boolean): object => {
		const root = call(system, 'root') as object;
		patch(proxyModule, Reflect.getPrototypeOf(system), 'system', sync);
		const directory = Reflect.getPrototypeOf(root);
		patch(proxyModule, directory, 'directory', sync);
		patch(
			proxyModule,
			directory && Reflect.getPrototypeOf(directory),
			'entry',
			sync,
		);
		return root;
	};
	const site = (root: object): Site => ({
		prefix,
		origin: page.origin,
		id,
		root,
	});
	/** a file system the page is about to get, with its site's directory as its root */
	const prepare = (
		system: object,
		done: () => void,
		failed: (error: unknown) => void,
	) => {
		if (sites.get(system)?.prefix === prefix) return done();
		call(nativeRoot(system, false), 'getDirectory', [
			prefix,
			{ create: true },
			(directory: object) => {
				sites.set(system, site(directory));
				done();
			},
			failed,
		]);
	};
	const prepareSync = (system: object) => {
		if (sites.get(system)?.prefix === prefix) return;
		const root = nativeRoot(system, true);
		sites.set(
			system,
			site(call(root, 'getDirectory', [prefix, { create: true }])),
		);
	};
	/** a page's filesystem: URL as the real one under the site, or one the browser refuses as another origin's */
	const realURL = (url: string): string => {
		if (!/^filesystem:/i.test(url)) return url;
		const match = /^([a-z][a-z\d+.-]*:\/\/[^/?#]*)([^?#]*)/i.exec(
			url.slice(11),
		);
		let origin = '';
		try {
			origin = match ? new URL(match[1]).origin : '';
		} catch (error) {
			// not an origin: the browser's answer
		}
		if (!match || !origin) return url;
		if (origin !== page.origin) return UNSAFE_URL;
		const [, type = '', ...rest] = match[2].split('/');
		let path: string;
		try {
			path = resolvePath(
				'/',
				rest.map((part) => decodeURIComponent(part)).join('/'),
			);
		} catch (error) {
			return url;
		}
		const real =
			(client as { realOrigin?: () => string }).realOrigin?.() ??
			new URL(client.global.location.href).origin;
		const encoded =
			path === '/'
				? ''
				: path
						.split('/')
						.map((part) => encodeURIComponent(part))
						.join('/');
		return `filesystem:${real}/${type}${prefix}${encoded}`;
	};

	return {
		webkitRequestFileSystem: (target, that, args) => {
			const [, , success, failure] = args;
			if (
				args.length < 3 ||
				typeof success !== 'function' ||
				!callable(failure)
			)
				return Reflect.apply(target, that, args);
			// an opaque origin has none: the browser's refusal of another
			// origin's URL is its refusal of that origin's request
			if (client.opaqueRequests && nativeResolve)
				return Reflect.apply(nativeResolve, that, [
					UNSAFE_URL,
					() => {},
					failure,
				]);
			args[2] = (system: object) =>
				prepare(
					system,
					() => Reflect.apply(success, undefined, [system]),
					(error) => failure && Reflect.apply(failure, undefined, [error]),
				);
			return Reflect.apply(target, that, args);
		},
		webkitResolveLocalFileSystemURL: (target, that, args) => {
			const [, success, failure] = args;
			if (
				args.length < 2 ||
				typeof success !== 'function' ||
				!callable(failure)
			)
				return Reflect.apply(target, that, args);
			args[0] = client.opaqueRequests ? UNSAFE_URL : realURL(String(args[0]));
			args[1] = (entry: object) => {
				const system = systemOf(entry);
				if (!system) return Reflect.apply(success, undefined, [entry]);
				prepare(
					system,
					() => Reflect.apply(success, undefined, [entry]),
					(error) => failure && Reflect.apply(failure, undefined, [error]),
				);
			};
			return Reflect.apply(target, that, args);
		},
		webkitRequestFileSystemSync: (target, that, args) => {
			const system = Reflect.apply(target, that, args) as object;
			prepareSync(system);
			return system;
		},
		webkitResolveLocalFileSystemSyncURL: (target, that, args) => {
			if (args.length) args[0] = realURL(String(args[0]));
			const entry = Reflect.apply(target, that, args) as object;
			const system = systemOf(entry);
			if (system) prepareSync(system);
			return entry;
		},
	};
}
