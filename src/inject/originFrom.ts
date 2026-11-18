// What Origin.from() answers a proxied page (modules/OriginFrom.ts, which
// says why): a deferred part of the document bundle (./dom/deferredParts.ts),
// made at a realm's first call, before the browser's; the worker bundle
// has it itself (./originFromParts.ts). Its top level reads no global.
import type Client from './Client';

type OriginObject = object;
export type OriginClass = {
	from(value: unknown): OriginObject;
	new (): OriginObject;
};

const tag = (value: unknown) => Object.prototype.toString.call(value);

/** the hook's body, for `client`'s realm, whose Origin.from is `nativeFrom` */
export function originFrom(
	client: Client,
	nativeFrom: Function,
	Origin: OriginClass,
) {
	const from = (value: unknown) => Reflect.apply(nativeFrom, Origin, [value]);
	/** the TypeError Chrome throws for a value it cannot extract an origin from */
	const refuse = () => from(null);
	/** each opaque origin this realm handed out, by what it was extracted from */
	const opaque = new WeakMap<object, OriginObject>();
	const ofOrigin = (origin: string, key: object): OriginObject => {
		if (origin !== 'null') return from(origin);
		let made = opaque.get(key);
		if (!made) opaque.set(key, (made = Reflect.construct(Origin, [])));
		return made;
	};
	const originOf = (of: Client) =>
		(of as { origin?: string }).origin ?? of.url.url.origin;
	const getter = (value: object, name: string) => {
		let proto = Reflect.getPrototypeOf(value);
		while (proto) {
			const descriptor = Reflect.getOwnPropertyDescriptor(proto, name);
			if (descriptor?.get) return Reflect.apply(descriptor.get, value, []);
			proto = Reflect.getPrototypeOf(proto);
		}
		return undefined;
	};
	return (target: Function, that: unknown, args: unknown[]): unknown => {
		const extracted = Reflect.apply(target, that, args);
		const value = args[0];
		if (value === client.global) return ofOrigin(originOf(client), client);
		const kind = tag(value);
		if (kind === '[object Window]') {
			// a window of the proxied world: of this document's origin, or
			// refused as Chrome refuses another origin's
			let other: Client | undefined;
			try {
				other = (value as Record<string, Client>)[client.names.client];
			} catch (error) {
				other = undefined;
			}
			if (!other || other.global !== value) return refuse();
			const origin = originOf(other);
			if (origin === 'null' || origin !== originOf(client)) return refuse();
			return from(origin);
		}
		if (
			kind === '[object HTMLAnchorElement]' ||
			kind === '[object HTMLAreaElement]'
		) {
			// the link's URL as the page wrote it, not its route
			try {
				return from(String(getter(value as object, 'href')));
			} catch (error) {
				return refuse();
			}
		}
		if (kind === '[object MessageEvent]') {
			// its sender's origin as the page reads it (Context module)
			const origin = String(getter(value as object, 'origin'));
			return origin === '' ? extracted : ofOrigin(origin, value as object);
		}
		return extracted;
	};
}
