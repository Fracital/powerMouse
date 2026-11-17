// navigator.storageBuckets per site (modules/StorageBuckets.ts): the
// methods behind the hooks, a deferred part of the document bundle
// (./dom/deferredParts.ts), made at a realm's first call, which most
// documents never make; a worker's bundle has them as its own code. Its top
// level reads no global, and what it calls of the page's realm it is
// handed, taken before any page script ran: a page that could change how
// its own prefix is computed could name another site's buckets.

/** a StorageBucket (the DOM types have none) */
type Bucket = object;
type Native = (...args: any[]) => any;
export type BucketMethod = (
	target: Native,
	that: unknown,
	args: unknown[],
) => unknown;

export interface BucketContext {
	/** the realm's storage key (src/partition.ts), read at each call */
	storageKey: () => string;
	/** whether the document is opaque (sandboxed), refused the buckets */
	opaque: () => boolean;
	isManager: (that: unknown) => boolean;
	nativeOpen: Native;
	/** hooks the name of a bucket's prototype (its first bucket's): set idbGet */
	named: (bucket: Bucket) => void;
	/** a bucket's indexedDB getter, as its prototype had it when named */
	idbGet?: Native;
	databasesOf?: Native;
	openDatabase?: Native;
	charCodeAt: Native;
	pow: (base: number, exponent: number) => number;
	Words: Int32ArrayConstructor;
	NativePromise: PromiseConstructor;
	promiseThen: Native;
	NativeMap: MapConstructor;
	DOMException: typeof DOMException;
	TypeError: TypeErrorConstructor;
}

/** open, keys and delete of StorageBucketManager, and a bucket's name */
export function bucketMethods(
	context: BucketContext,
): Record<'open' | 'keys' | 'delete' | 'name', BucketMethod> {
	const {
		isManager,
		nativeOpen,
		databasesOf,
		openDatabase,
		charCodeAt,
		pow,
		Words,
		NativePromise,
		promiseThen,
		NativeMap,
		DOMException,
		TypeError,
	} = context;
	const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
	/** how many characters of a bucket's real name are its site's prefix */
	const PREFIX = 24;
	/** the longest name Chrome takes (measured in Chrome 157) */
	const LONGEST = 63;

	let rounds: InstanceType<typeof Words> | null = null;
	let initial: InstanceType<typeof Words> | null = null;
	/** SHA-256's constants: the fractional parts of the primes' cube and square roots */
	function constants() {
		if (rounds && initial) return;
		const k = new Words(64);
		const h = new Words(8);
		const word = 4294967296;
		let found = 0;
		for (let candidate = 2; found < 64; candidate++) {
			let prime = true;
			for (let divisor = 2; divisor * divisor <= candidate; divisor++)
				if (candidate % divisor === 0) {
					prime = false;
					break;
				}
			if (!prime) continue;
			if (found < 8) h[found] = (pow(candidate, 1 / 2) * word) | 0;
			k[found++] = (pow(candidate, 1 / 3) * word) | 0;
		}
		rounds = k;
		initial = h;
	}

	/**
	 * SHA-256 of a string's UTF-16 code units, as `PREFIX` characters of
	 * [a-z0-9] (about 124 bits), with nothing a page can replace: no array or
	 * string method, no global read when it runs
	 */
	function digest(text: string): string {
		constants();
		const k = rounds!;
		const length = text.length * 2;
		const blocks = ((length + 8) >> 6) + 1;
		const message = new Words(blocks * 16);
		for (let i = 0; i < text.length; i++) {
			const unit = Reflect.apply(charCodeAt, text, [i]) as number;
			const at = i * 2;
			message[at >> 2] |= (unit >>> 8) << (24 - (at & 3) * 8);
			message[(at + 1) >> 2] |= (unit & 255) << (24 - ((at + 1) & 3) * 8);
		}
		message[length >> 2] |= 0x80 << (24 - (length & 3) * 8);
		message[blocks * 16 - 1] = length * 8;
		const h = new Words(initial!);
		const w = new Words(64);
		for (let offset = 0; offset < message.length; offset += 16) {
			for (let i = 0; i < 64; i++) {
				if (i < 16) w[i] = message[offset + i];
				else {
					const a = w[i - 15];
					const b = w[i - 2];
					w[i] =
						(((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) +
						w[i - 7] +
						(((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)) +
						w[i - 16];
				}
			}
			let a = h[0];
			let b = h[1];
			let c = h[2];
			let d = h[3];
			let e = h[4];
			let f = h[5];
			let g = h[6];
			let j = h[7];
			for (let i = 0; i < 64; i++) {
				const t1 =
					(j +
						(((e >>> 6) | (e << 26)) ^
							((e >>> 11) | (e << 21)) ^
							((e >>> 25) | (e << 7))) +
						((e & f) ^ (~e & g)) +
						k[i] +
						w[i]) |
					0;
				const t2 =
					((((a >>> 2) | (a << 30)) ^
						((a >>> 13) | (a << 19)) ^
						((a >>> 22) | (a << 10))) +
						((a & b) ^ (a & c) ^ (b & c))) |
					0;
				j = g;
				g = f;
				f = e;
				e = (d + t1) | 0;
				d = c;
				c = b;
				b = a;
				a = (t1 + t2) | 0;
			}
			h[0] += a;
			h[1] += b;
			h[2] += c;
			h[3] += d;
			h[4] += e;
			h[5] += f;
			h[6] += g;
			h[7] += j;
		}
		// six characters from each of the first four words
		let out = '';
		for (let i = 0; i < 4; i++) {
			let value = h[i] >>> 0;
			for (let n = 0; n < 6; n++) {
				out += ALPHABET[value % 36];
				value = (value - (value % 36)) / 36;
			}
		}
		return out;
	}

	/** whether `name` starts with `head`, read by index (no string method) */
	function startsWith(name: string, head: string): boolean {
		if (name.length < head.length) return false;
		for (let i = 0; i < head.length; i++) if (name[i] !== head[i]) return false;
		return true;
	}

	/** `name` from `from` on, read by index */
	function rest(name: string, from: number): string {
		let out = '';
		for (let i = from; i < name.length; i++) out += name[i];
		return out;
	}

	/** whether Chrome takes `name` for a bucket: [a-z0-9][a-z0-9_-]*, at most 63 */
	function validName(name: string): boolean {
		if (!name.length || name.length > LONGEST) return false;
		for (let i = 0; i < name.length; i++) {
			const unit = Reflect.apply(charCodeAt, name, [i]) as number;
			const alphanumeric =
				(unit >= 0x61 && unit <= 0x7a) || (unit >= 0x30 && unit <= 0x39);
			if (!alphanumeric && (i === 0 || (unit !== 0x5f && unit !== 0x2d)))
				return false;
		}
		return true;
	}

	// the last storage key's prefix (no Map: a page could answer for it)
	let keyed = '';
	let keyedPrefix = '';
	const prefix = () => {
		const key = context.storageKey();
		if (key !== keyed || !keyedPrefix) {
			keyedPrefix = digest(key);
			keyed = key;
		}
		return keyedPrefix;
	};
	/** the page's names of the long names' buckets, by their real names */
	const longNames = new NativeMap<string, string>();
	const realName = (name: string) =>
		name.length + PREFIX <= LONGEST
			? `${prefix()}${name}`
			: `${prefix()}_${digest(name)}`;
	const refused = (method: string) =>
		context.opaque()
			? new DOMException(
					`Failed to execute '${method}' on 'StorageBucketManager': Access to Storage Buckets API is denied in this context.`,
					'SecurityError',
				)
			: null;
	/** the page's name of a long name's bucket, from the database it holds */
	const recorded = async (bucket: Bucket) => {
		const idbGet = context.idbGet;
		if (!idbGet || !databasesOf) return null;
		const idb = Reflect.apply(idbGet, bucket, []) as IDBFactory;
		const list = (await Reflect.apply(
			databasesOf,
			idb,
			[],
		)) as IDBDatabaseInfo[];
		for (let i = 0; i < list.length; i++) {
			const name = list[i].name;
			if (typeof name === 'string' && name[0] === '#') return rest(name, 1);
		}
		return null;
	};
	const record = (bucket: Bucket, name: string) =>
		new NativePromise<void>((resolve) => {
			const idbGet = context.idbGet;
			if (!idbGet || !openDatabase) return resolve();
			const idb = Reflect.apply(idbGet, bucket, []) as IDBFactory;
			const request = Reflect.apply(openDatabase, idb, [
				`#${name}`,
			]) as IDBOpenDBRequest;
			request.onsuccess = () => {
				request.result.close();
				resolve();
			};
			request.onerror = () => resolve();
		});

	const open: BucketMethod = async (target, that, args) => {
		if (!args.length || typeof args[0] === 'symbol' || !isManager(that))
			return await Reflect.apply(target, that, args);
		const error = refused('open');
		if (error) throw error;
		const name = String(args[0]);
		const options = args.length > 1 ? [args[1]] : [];
		if (!validName(name)) {
			// the options are read (and refused) first, as natively;
			// an empty name makes nothing
			try {
				await Reflect.apply(target, that, ['', ...options]);
			} catch (refusal) {
				if (!/is not a valid name/.test((refusal as Error)?.message))
					throw refusal;
			}
			throw new TypeError(`The bucket name '${name}' is not a valid name.`);
		}
		const real = realName(name);
		const bucket = (await Reflect.apply(target, that, [
			real,
			...options,
		])) as Bucket;
		context.named(bucket);
		if (real.length !== PREFIX + name.length) {
			longNames.set(real, name);
			if ((await recorded(bucket)) !== name) await record(bucket, name);
		}
		return bucket;
	};

	const remove: BucketMethod = async (target, that, args) => {
		if (!args.length || typeof args[0] === 'symbol' || !isManager(that))
			return await Reflect.apply(target, that, args);
		const error = refused('delete');
		if (error) throw error;
		const name = String(args[0]);
		if (!validName(name))
			throw new TypeError(`The bucket name ${name} is not a valid name.`);
		return await Reflect.apply(target, that, [realName(name)]);
	};

	// the real names are filtered where the browser hands them over, in a
	// reaction no page code sees (an await would show them to a page that
	// replaced Promise.prototype.then)
	const keys: BucketMethod = (target, that, args) => {
		if (!isManager(that)) return Reflect.apply(target, that, args);
		const error = refused('keys');
		if (error) return new NativePromise((resolve, reject) => reject(error));
		const own = prefix();
		const listed = (real: string[]) => {
			const names: string[] = [];
			const long: string[] = [];
			for (let i = 0; i < real.length; i++) {
				const name = real[i];
				if (name.length <= PREFIX || !startsWith(name, own)) continue;
				if (name[PREFIX] === '_') long[long.length] = name;
				else names[names.length] = rest(name, PREFIX);
			}
			if (!long.length) return names.sort();
			return (async () => {
				for (let i = 0; i < long.length; i++) {
					let name = longNames.get(long[i]) ?? null;
					if (name === null) {
						const bucket = (await Reflect.apply(nativeOpen, that, [
							long[i],
						])) as Bucket;
						context.named(bucket);
						name = await recorded(bucket);
						if (name !== null) longNames.set(long[i], name);
					}
					if (name !== null) names[names.length] = name;
				}
				return names.sort();
			})();
		};
		return Reflect.apply(promiseThen, Reflect.apply(target, that, args), [
			listed,
		]);
	};

	const name: BucketMethod = (target, that, args) => {
		const real = Reflect.apply(target, that, args) as string;
		const long = longNames.get(real);
		if (long !== undefined) return long;
		return real.length > PREFIX ? rest(real, PREFIX) : real;
	};

	return { open, keys, delete: remove, name };
}
