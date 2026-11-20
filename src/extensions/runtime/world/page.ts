// What the page's runtime hands an isolated world (./index.ts makeWorld),
// taken as the runtime's file runs, before the inject and before any page
// script: the page's window and the members of its realm the world's
// membrane judges and copies values by. Made in the page's realm, so the
// functions here are the page's: the browser calls them where it would
// drop a call into the world's realm, whose frame is gone.
import type { webNatives } from '../natives';

export interface PageSide {
	/** the page's window */
	window: Window & Record<string, unknown>;
	/** its web members, `callback` making the page's function of a world's */
	natives: ReturnType<typeof webNatives>;
	/** the access API of the page's inject (src/inject/modules/Access.ts), once it is there */
	access(): PageAccess | undefined;
	/** an object, an array and a promise of the page's realm */
	object(): Record<PropertyKey, unknown>;
	array(): unknown[];
	promise(
		executor: (
			resolve: (value: unknown) => void,
			reject: (error: unknown) => void,
		) => void,
	): Promise<unknown>;
	/** the page's interface prototypes the membrane tells objects apart by */
	protos: {
		Object: object;
		Function: object;
		Node: object;
		Element: object;
		Document: object;
		Window: object;
		Storage: object;
		DOMStringMap: object;
		CSSStyleDeclaration: object;
		HTMLOptionsCollection: object;
		HTMLSelectElement: object;
		HTMLFormElement: object;
		HTMLScriptElement: object;
		Range: object;
		DOMParser: object;
		Promise: object;
		Error: object;
		DOMException: object;
	};
	/** the page's Promise.prototype.then */
	then: Function;
	/**
	 * Reflect's operations as functions of the page's realm: a member of the
	 * page's runs with the page's realm as the current one, which the
	 * browser takes a listener's, a channel's or an observer's realm from
	 * (one of the world's, whose frame is gone, gets nothing)
	 */
	reflect: {
		apply(fn: Function, that: unknown, args: ArrayLike<unknown>): any;
		construct(
			fn: Function,
			args: ArrayLike<unknown>,
			newTarget?: Function,
		): any;
		get(target: object, key: PropertyKey, receiver?: unknown): any;
		set(
			target: object,
			key: PropertyKey,
			value: unknown,
			receiver?: unknown,
		): boolean;
		has(target: object, key: PropertyKey): boolean;
		ownKeys(target: object): (string | symbol)[];
		getOwnPropertyDescriptor(
			target: object,
			key: PropertyKey,
		): PropertyDescriptor | undefined;
		defineProperty(
			target: object,
			key: PropertyKey,
			descriptor: PropertyDescriptor,
		): boolean;
		deleteProperty(target: object, key: PropertyKey): boolean;
	};
	/** Element's localName getter */
	localName: (element: unknown) => string;
	/**
	 * Keep the members of the page's window and interfaces as they are now,
	 * with the inject's hooks and before the page's scripts and its MAIN
	 * world's (the runtime's start: entry.ts): what the world reads of them
	 * from then on, as an isolated world in Chrome has wrappers of its own
	 * that no change of the page's reaches
	 */
	snapshot(): void;
	/** an object's own properties as the snapshot kept them (none for one it did not keep) */
	original(object: object): Record<PropertyKey, PropertyDescriptor> | undefined;
}

/** what of the page's access API the world asks (a window's `location` and `top`, and a write of `location`) */
export interface PageAccess {
	/** `target[key]` as a rewritten script reads it */
	get2(target: unknown, key: string): unknown;
	set2(
		target: unknown,
		key: string,
		operate: (target: any, key: string, value: unknown) => unknown,
		value: unknown,
	): unknown;
}

/** what the page's runtime tells a world of the document and the extension */
export interface WorldConfig {
	/** the extension, as JSON (parsed in the world's realm) */
	ext: string;
	channel: string;
	url: string;
	token: string | undefined;
	/** where the context is, as JSON, once the hub said */
	place?: string;
}
