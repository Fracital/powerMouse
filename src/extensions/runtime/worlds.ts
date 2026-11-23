// The isolated worlds of a document (docs/extensions.md "Isolated worlds"),
// as the page's runtime makes them. A world is a realm of its own: an
// about:blank frame's, made in a closed shadow root and taken out of the
// document again in one synchronous run, so no script of the page's ever
// sees the frame (in `window.length`, `frames`, the DOM or an observer's
// records) and nothing of it stays in the page. The world's bundle
// (./world/, embedded here as text by build.js) is evaluated in that realm
// before the frame goes, and makes the world of the realm's JavaScript and
// the page's DOM.
import worldSource from 'extensions-world:source';
import { WORLD_FACTORY } from '../types';
import { call, masking, natives, type webNatives } from './natives';
import type { World } from './world/index';
import type { PageAccess, PageSide, WorldConfig } from './world/page';

type Web = ReturnType<typeof webNatives>;
type Global = typeof globalThis & Record<string, unknown>;

/**
 * A function of the page's realm that calls `fn` (the browser drops its own
 * calls into a world's). The page may come to hold it (a handler property
 * the world set, a listener it reads back): it shows as a native, by the
 * inject's toString (natives.ts masking)
 */
function callback<T extends Function>(fn: T, named: Function = fn): T {
	const apply = natives.Reflect.apply;
	const made = function (this: unknown) {
		// eslint-disable-next-line prefer-rest-params
		return apply(fn, this, arguments);
	};
	// (its own `name` and `length`, as data: no getter of the world's runs)
	const own = (key: string) =>
		natives.getOwnPropertyDescriptor(named, key)?.value as unknown;
	const name = typeof own('name') === 'string' ? (own('name') as string) : '';
	const length = typeof own('length') === 'number' ? own('length') : 0;
	natives.defineProperty(made, 'name', { value: name, configurable: true });
	natives.defineProperty(made, 'length', { value: length, configurable: true });
	masking.native(made, name);
	return made as unknown as T;
}

/**
 * What a world is handed of the page's: taken as the runtime's file runs,
 * before the inject and any page script (`accessName` is the inject's
 * access API's, which the shell's payload says)
 */
export function pageSide(
	global: Global,
	web: Web,
	accessName: () => string,
): PageSide {
	const proto = (name: string) =>
		(global[name] as { prototype: object } | undefined)?.prototype ??
		natives.Error.prototype;
	const PagePromise = global.Promise;
	// (Reflect's own, as the page cannot have changed them yet)
	const Page = global.Reflect;
	const reflect = {
		apply: Page.apply,
		construct: Page.construct,
		get: Page.get,
		set: Page.set,
		has: Page.has,
		ownKeys: Page.ownKeys,
		getOwnPropertyDescriptor: Page.getOwnPropertyDescriptor,
		defineProperty: Page.defineProperty,
		deleteProperty: Page.deleteProperty,
	};
	const NumberProto = global.Number.prototype;
	const ownDescriptor = natives.getOwnPropertyDescriptor;
	const ownDescriptors = global.Object.getOwnPropertyDescriptors;
	let originals: WeakMap<
		object,
		Record<PropertyKey, PropertyDescriptor>
	> | null = null;
	return {
		window: global as unknown as PageSide['window'],
		natives: { ...web, callback },
		access() {
			const name = accessName();
			const api = name ? ownDescriptor(NumberProto, name)?.value : undefined;
			return api && typeof api.get2 === 'function'
				? (api as PageAccess)
				: undefined;
		},
		object: () => ({}),
		array: () => [],
		promise: (executor) => new PagePromise(executor),
		protos: {
			Object: global.Object.prototype,
			Function: global.Function.prototype,
			Node: proto('Node'),
			Element: proto('Element'),
			Document: proto('Document'),
			Window: proto('Window'),
			Storage: proto('Storage'),
			DOMStringMap: proto('DOMStringMap'),
			CSSStyleDeclaration: proto('CSSStyleDeclaration'),
			HTMLOptionsCollection: proto('HTMLOptionsCollection'),
			HTMLSelectElement: proto('HTMLSelectElement'),
			HTMLFormElement: proto('HTMLFormElement'),
			HTMLScriptElement: proto('HTMLScriptElement'),
			Range: proto('Range'),
			DOMParser: proto('DOMParser'),
			Promise: PagePromise.prototype,
			Error: global.Error.prototype,
			DOMException: proto('DOMException'),
		},
		then: PagePromise.prototype.then,
		reflect: {
			apply: (fn, that, args) => reflect.apply(fn, that, args),
			construct: (fn, args, newTarget) =>
				newTarget === undefined
					? reflect.construct(fn, args)
					: reflect.construct(fn, args, newTarget),
			get: (target, key, receiver) =>
				reflect.get(target, key, receiver ?? target),
			set: (target, key, value, receiver) =>
				reflect.set(target, key, value, receiver ?? target),
			has: (target, key) => reflect.has(target, key),
			ownKeys: (target) => reflect.ownKeys(target),
			getOwnPropertyDescriptor: (target, key) =>
				reflect.getOwnPropertyDescriptor(target, key),
			defineProperty: (target, key, descriptor) =>
				reflect.defineProperty(target, key, descriptor),
			deleteProperty: (target, key) => reflect.deleteProperty(target, key),
		},
		localName: web.localName,
		snapshot() {
			if (originals) return;
			originals = new WeakMap();
			const keep = (object: unknown) => {
				if (
					object !== null &&
					(typeof object === 'object' || typeof object === 'function') &&
					!originals!.has(object)
				)
					originals!.set(object, ownDescriptors(object));
			};
			keep(global);
			for (const name of reflect.ownKeys(global)) {
				const value = ownDescriptor(global, name)?.value;
				if (typeof value !== 'function') continue;
				const prototype = ownDescriptor(value, 'prototype')?.value;
				if (prototype === null || typeof prototype !== 'object') continue;
				keep(value);
				keep(prototype);
			}
		},
		original: (object) => originals?.get(object),
	};
}

/**
 * Make a world: its realm, its bundle, the world itself. `hidden` is the
 * inject's hiddenMutation, which keeps the frame's coming and going from
 * the page's observers once the page could have any; `document` is the
 * page's (the runtime's own, or a local frame's). Null when the
 * document cannot make one (a sandbox with no scripts for its frames)
 */
export function makeWorld(
	page: PageSide,
	config: WorldConfig,
	hidden: (<T>(run: () => T) => T) | null,
	document: Document = natives.document,
): World | null {
	const make = () => {
		const parent = natives.documentElement(document) ?? document;
		const host = call<Element>(natives.createElement, document, 'div');
		const root = call<ShadowRoot>(natives.attachShadow, host, {
			mode: 'closed',
		});
		const frame = call<HTMLIFrameElement>(
			natives.createElement,
			document,
			'iframe',
		);
		call(natives.appendChild, root, frame);
		call(natives.appendChild, parent, host);
		try {
			const realm = natives.contentWindow(frame) as Global | null;
			if (!realm) return null;
			(realm.eval as (code: string) => unknown)(worldSource);
			const factory = realm[WORLD_FACTORY] as
				((page: PageSide, config: WorldConfig) => World) | undefined;
			delete realm[WORLD_FACTORY];
			return factory ? factory(page, config) : null;
		} finally {
			call(natives.removeChild, parent, host);
		}
	};
	try {
		return hidden ? hidden(make) : make();
	} catch (error) {
		// a document whose policy forbids eval (a sandboxed frame's guard)
		// runs its isolated scripts in the shared realm, as expected
		if ((error as Error | null)?.name !== 'EvalError')
			natives.console.error(
				'STomp: an isolated world could not be made:',
				error,
			);
		return null;
	}
}
