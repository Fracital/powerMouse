// The inject's side of a rewritten script, for the differential harness
// (test/differential/harness.mjs): the real access API, Function hooks and
// toString hook of src/inject, bundled on their own and installed on a realm
// through a client that is only what those three modules ask of one. What
// the real client answers from the DOM (which window is the top, which
// names a window hides) is answered from the harness's world
// (test/differential/world.js).
import { parseConfig } from '../../src/config';
import { helperNames } from '../../src/helperNames';
import AccessModule from '../../src/inject/modules/Access';
import FunctionModule from '../../src/inject/modules/Function';
import ProxyModule from '../../src/inject/modules/Proxy';
import StompURL from '../../src/StompURL';
import { useHost } from './shims/rewriter';

interface World {
	windows: Set<unknown>;
	resolveTop: (value: unknown) => unknown;
	navigationRoute: (destination: URL) => string;
}

interface Host {
	rewrite: (script: string, type: string, preamble: string) => unknown[];
	print: (source: string, part: string) => string | null;
	config: object;
	base: string;
}

Reflect.defineProperty(globalThis, '__differential', {
	configurable: true,
	value: (host: Host, world: World) => {
		useHost(host);
		const names = helperNames(host.config);
		const hidden = new Set<unknown>([
			names.access,
			names.client,
			names.globalProxy,
			names.globalName,
		]);
		const modules = new Map<unknown, unknown>();
		// a real StompURL: the access API routes the modules a page imports
		// (`$s$j.import`, `importRoute`) from the client's
		const url = new StompURL(
			host.base,
			parseConfig(host.config as never, 'k').codec,
			(host.config as { directory: string }).directory,
		);
		const client = {
			global: globalThis,
			names,
			config: host.config,
			url,
			baseURL: url,
			scriptFacts: { evaluates: true },
			getModule: (Module: unknown) => modules.get(Module),
			trustedValue: (value: unknown) => value,
			codeEval: () => null,
			noteCodeSample: () => undefined,
			resolveTop: world.resolveTop,
			navigationRoute: world.navigationRoute,
			// (src/inject/modules/Reflection.ts: the helpers' names are on no
			// window)
			hidesName: (target: unknown, key: unknown) =>
				hidden.has(key) &&
				(world.windows.has(target) || target === Number.prototype),
		};
		for (const Module of [ProxyModule, AccessModule, FunctionModule]) {
			const module = new Module(client as never);
			modules.set(Module, module);
			module.apply();
		}
	},
});
