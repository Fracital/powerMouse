// What the inject's Credentials module (modules/Credentials.ts) hands the
// WebAuthn client (passkeys.ts, a deferred statement, ./passkeysPart.ts) when a
// document first makes a WebAuthn call or asks a PublicKeyCredential static:
// the client is evaluated then, not with the bundle, so a document that
// never asks carries none of it. Everything here was taken when the module
// applied, before any page script ran.
import type ProxyModule from '../modules/Proxy';
import type DocumentClient from './Client';

/** the document's constructors the client takes besides the Credentials module's own */
export const REALM = [
	'Array',
	'ArrayBuffer',
	'Uint8Array',
	'Proxy',
	'WeakMap',
	'Symbol',
	'String',
] as const;

export interface PasskeysContext {
	client: DocumentClient;
	proxyModule: ProxyModule;
	/** the document's navigator.credentials */
	container: object;
	/**
	 * The Credentials module's guard of the browser's own WebAuthn calls
	 * (its relying party id kept from the network and from the browser's
	 * authenticator), and the browser's own create and get it wraps
	 */
	guard: (
		call: (args: unknown[]) => unknown,
		args: unknown[],
		path: string[],
		kind: 'create' | 'get' | 'signal',
	) => unknown;
	natives: [create: Function, get: Function];
	/** the document's PublicKeyCredential, the statics' receiver */
	PublicKeyCredential: Function;
	/** the document's own constructors */
	realm: {
		Promise: PromiseConstructor;
		TypeError: TypeErrorConstructor;
		DOMException: typeof DOMException;
		Object: ObjectConstructor;
		Array: ArrayConstructor;
		ArrayBuffer: ArrayBufferConstructor;
		Uint8Array: Uint8ArrayConstructor;
		Proxy: ProxyConstructor;
		WeakMap: WeakMapConstructor;
		Symbol: SymbolConstructor;
		String: StringConstructor;
	};
	/** AbortSignal's aborted and reason getters, and addEventListener */
	signal: [aborted: Function, reason: Function, listen: Function];
	/** the FedCM flow of the Credentials module, for a request that names an identity */
	identity: (identity: unknown, signal: unknown, mediation: unknown) => unknown;
}

/** what the client does for one document */
export interface PasskeysInstalled {
	/** navigator.credentials.create and get, for any arguments */
	create(that: unknown, args: unknown[]): unknown;
	get(that: unknown, args: unknown[]): unknown;
	/** a PublicKeyCredential static by name (capabilities, signal*), with the browser's own as `target` */
	statics(name: string, target: Function, args: unknown[]): unknown;
}
