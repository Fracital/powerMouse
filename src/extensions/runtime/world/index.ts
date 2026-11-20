// An extension's isolated world in one document (docs/extensions.md
// "Isolated worlds"). This file and what it imports are a bundle of their
// own (build.js, `extensionsWorld`), whose text the page's runtime
// evaluates in the realm of a frame it makes and takes out of the document
// again (../worlds.ts makeWorld): the world's JavaScript is that realm's,
// its chrome.* is made here of the realm's objects, and it reaches the page
// through the membrane (./membrane.ts) only. Once the frame is gone the
// browser runs no callback of the realm's and binds a web call made from
// it to the dead frame, so every call into the page goes through the
// page's own functions (page.reflect, page.natives.callback).
import { buildChrome } from '../api';
import { Context } from '../context';
import { receiveMessages } from '../messaging';
import { scriptNatives, useNatives } from '../natives';
import { makeGlobal } from './global';
import { createMembrane } from './membrane';
import { ModuleLoader } from './modules';
import type { PageSide, WorldConfig } from './page';

/** what the page's runtime does with a world */
export interface World {
	/** where the world's context is, as JSON, once the hub said */
	placed(place: string | null): void;
	/** an entry's scripts (the worker's world source), as code at `url` */
	run(source: string, url: string): void;
	/** an injection's code: what it hands `$result`, else its completion value */
	exec(source: string, url: string): unknown;
	/** the same as the page's JSON (an injection's result) */
	json(value: unknown): string;
}

const { defineProperty, deleteProperty } = Reflect;
const objectCreate = Object.create;
const indirectEval = eval;

/** the realm's global name a script's scope is under while the script starts */
const SCOPE = '$world$scope';

/** the names a script's scope answers as the world's global does */
const SCOPED = [
	'window',
	'self',
	'globalThis',
	'frames',
	'document',
	'location',
	'top',
	'parent',
	'chrome',
];

export function makeWorld(page: PageSide, config: WorldConfig): World {
	const realm = globalThis as typeof globalThis & Record<string, unknown>;
	// the world's Trusted Types policy, which no list of the page's names
	// (the browser enforces none of the page's: src/csp.ts browserPolicy).
	// Its rules are functions of the page's realm and its methods are called
	// from there: the browser runs no callback of a realm whose frame is gone
	let trusted: Parameters<typeof createMembrane>[1] = null;
	try {
		const factory = realm.trustedTypes as
			| { createPolicy(name: string, rules: object): Record<string, Function> }
			| undefined;
		const same = page.natives.callback((text: string) => text);
		// (made from the page's realm too: the browser takes the realm that
		// made a callback as the one it must still run in)
		const policy =
			factory &&
			(page.reflect.apply(factory.createPolicy, factory, [
				`world-${Math.random().toString(36).slice(2)}`,
				{ createHTML: same, createScript: same, createScriptURL: same },
			]) as Record<string, Function>);
		if (policy) {
			const method =
				(name: string) =>
				(text: string): unknown =>
					page.reflect.apply(policy[name], policy, [text]);
			trusted = {
				createHTML: method('createHTML'),
				createScript: method('createScript'),
				createScriptURL: method('createScriptURL'),
			};
		}
	} catch (error) {
		// no Trusted Types: the page's sinks take strings
	}
	const membrane = createMembrane(page, trusted);
	const web = page.natives;
	const callback = web.callback;
	// (the page's members called from the page's realm: page.reflect)
	const pageApply = page.reflect.apply;
	const own = scriptNatives(realm);
	const viaPage =
		<T extends Function>(fn: T) =>
		(...args: unknown[]) =>
			pageApply(fn, undefined, args);
	useNatives({
		...web,
		...own,
		Reflect: { ...own.Reflect, apply: pageApply as typeof Reflect.apply },
		fetch: viaPage(web.fetch) as typeof fetch,
		setTimeout: ((fn: Function, ms?: number) =>
			pageApply(web.setTimeout, undefined, [
				callback(fn),
				ms,
			])) as typeof setTimeout,
		setInterval: ((fn: Function, ms?: number) =>
			pageApply(web.setInterval, undefined, [
				callback(fn),
				ms,
			])) as typeof setInterval,
		clearTimeout: viaPage(web.clearTimeout) as typeof clearTimeout,
		clearInterval: viaPage(web.clearInterval) as typeof clearInterval,
		BroadcastChannel: channelOf(page, membrane.toWorld),
	});
	const ext = JSON.parse(config.ext);
	const ctx = new Context(
		ext,
		'content',
		config.channel,
		config.url,
		config.token,
	);
	let settle: () => void = () => {};
	ctx.placed = new Promise<void>((resolve) => (settle = resolve));
	receiveMessages(ctx);
	const chrome = buildChrome(ctx);
	const globals = (url: string) => {
		const own = global as Record<string, unknown>;
		return [
			chrome,
			global,
			global,
			global,
			own.document,
			own.location,
			own.top,
			own.parent,
			global,
			(specifier: unknown) => loader.import(specifier, url),
		];
	};
	// A script runs as the realm's global code, so its `var`s and functions
	// are the world's globals, which the world's other scripts see (as in
	// Chrome), in a scope that answers the names of the realm's window no
	// script can take off it (window, document, location, top) and the
	// others its global answers as the world's
	const scopeOf = (url: string, result?: (value: unknown) => void) => {
		const scope = objectCreate(null) as Record<string, unknown>;
		const own = global as Record<string, unknown>;
		for (const name of SCOPED)
			defineProperty(scope, name, {
				get: () => own[name],
				set: (value: unknown) => {
					own[name] = value;
				},
			});
		scope.$world$import = (specifier: unknown) => loader.import(specifier, url);
		if (result) scope.$result = result;
		return scope;
	};
	const evaluate = (
		code: string,
		url: string,
		result?: (value: unknown) => void,
	) => {
		defineProperty(realm, SCOPE, {
			value: scopeOf(url, result),
			configurable: true,
		});
		try {
			return indirectEval(
				`with (${SCOPE}) {${code}\n}\n//# sourceURL=${url.replace(/\s/g, '%20')}`,
			);
		} finally {
			deleteProperty(realm, SCOPE);
		}
	};
	const global: object = makeGlobal(realm, membrane, page, chrome, (code) =>
		evaluate(code, config.url),
	);
	membrane.useGlobal(global);
	const loader = new ModuleLoader(
		ext.id,
		Number(ext.generation) || 0,
		config.channel,
		globals,
		(text) => indirectEval(text),
	);
	return {
		placed(place) {
			if (place) ctx.place = JSON.parse(place);
			settle();
			ctx.announce();
		},
		run(source, url) {
			try {
				evaluate(source, url);
			} catch (error) {
				membrane.report(error);
			}
		},
		exec(source, url) {
			let given = false;
			let value: unknown;
			const completion = evaluate(source, url, (result: unknown) => {
				given = true;
				value = result;
			});
			return given ? value : completion;
		},
		json: (value) => JSON.stringify(value === undefined ? null : value),
	};
}

/**
 * The world's BroadcastChannel: the page's, whose handler is a function of
 * the page's realm, and whose messages are copied into the world's
 */
function channelOf(
	page: PageSide,
	toWorld: (value: unknown) => unknown,
): typeof BroadcastChannel {
	const web = page.natives;
	const reflect = page.reflect;
	const proto = web.BroadcastChannel.prototype;
	const post = proto.postMessage;
	const close = proto.close;
	class Channel {
		readonly #channel: BroadcastChannel;
		constructor(name: string) {
			this.#channel = reflect.construct(web.BroadcastChannel, [name]);
		}
		postMessage(message: unknown) {
			reflect.apply(post, this.#channel, [message]);
		}
		close() {
			reflect.apply(close, this.#channel, []);
		}
		set onmessage(handler: (event: { data: unknown }) => void) {
			reflect.set(
				this.#channel,
				'onmessage',
				web.callback((event: MessageEvent) =>
					handler({ data: toWorld(reflect.get(event, 'data')) }),
				),
			);
		}
	}
	return Channel as unknown as typeof BroadcastChannel;
}
