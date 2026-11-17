// What runs before a script's own code. It needs no parser, so the inject's
// light rewriter library (src/rewriterLight.ts) builds it for the wasm
// module without holding the JavaScript rewriter (src/rewriteJS.ts), which
// builds the same text from here.
import type { Config } from './config';
import { helperNames } from './helperNames';
import { injectWorkerJS } from './routeURL';
import {
	BARE_SPECIFIER,
	isModuleType,
	RELATIVE_SPECIFIER,
	type ScriptType,
} from './scriptRoutes';
import type StompURL from './StompURL';
import { workletAccess } from './workletLead';

/**
 * What runs before a script's own code, after its directive prologue: a
 * worker's bootstrap, a module's `import.meta.url`, and the caller's
 * `preamble`. The same text whichever backend rewrites the script.
 */
export function scriptLead(
	url: StompURL,
	config: Config,
	type: ScriptType,
	preamble: string,
): string {
	const names = helperNames(config);
	const isModule = isModuleType(type);
	const isWorker = type === 'workerModule' || type === 'worker';
	const bundle = JSON.stringify(injectWorkerJS(url, config));
	return (
		// a module worker has no importScripts: fetch the bundle and run it
		// as the classic script it is (indirect eval, top-level await),
		// named for its URL, so its frames are dropped from stacks like
		// those of a bundle a classic worker imports
		// (once: the bundle deletes createClient when the client is made,
		// and a module worker's imports each carry this preamble). The
		// browser dispatches messages during a top-level await, when the
		// page's module has not set its handlers yet (natively its top
		// level runs first): those, and a shared worker's connects, are
		// held and the client dispatches them again
		// (Two modules the worker's module imports are evaluated side by
		// side: the second's preamble starts while the first's waits for the
		// bundle. Each fetched and evaluated the bundle, the second after
		// the first's client had hooked the scope, and the worker ended on
		// "Cannot read properties of undefined (reading 'releaseHeld')". The
		// first preamble's work is one promise every other waits for, under
		// a name that is gone before any of the page's code runs.)
		// (all of it on the script's first line: an uncaught error and a
		// stack name the page's lines by their own numbers)
		(type === 'workerModule'
			? `if (!(${JSON.stringify(names.client)} in globalThis)) { ` +
				`const boot = ${JSON.stringify(`${names.client}$`)}; ` +
				'if (!(boot in globalThis)) Object.defineProperty(globalThis, boot, { configurable: true, value: (async () => { ' +
				'let held; ' +
				'if (!globalThis.createClient) { ' +
				'held = []; ' +
				'const hold = (event) => { event.stopImmediatePropagation(); held.push(event); }; ' +
				"addEventListener('message', hold); " +
				"addEventListener('connect', hold); " +
				`try { (0, eval)((await (await fetch(${bundle})).text()) + '\\n//# sourceURL=' + new globalThis.URL(${bundle}, globalThis.location.href).href); } ` +
				"finally { removeEventListener('message', hold); removeEventListener('connect', hold); } " +
				'} ' +
				`createClient(${JSON.stringify(config)}, ${JSON.stringify(url.codec.key)}, held); ` +
				'})() }); ' +
				'try { await globalThis[boot]; } finally { delete globalThis[boot]; } ' +
				'} ' +
				`if (!${names.client}.applied) ${names.client}.apply();`
			: isWorker
				? `if (!(${JSON.stringify(names.client)} in globalThis) && !globalThis.createClient) importScripts(${bundle}); ` +
					`if (!(${JSON.stringify(names.client)} in globalThis)) createClient(${JSON.stringify(config)}, ${JSON.stringify(url.codec.key)}); ` +
					`if (!${names.client}.applied) ${names.client}.apply();`
				: type === 'workletModule'
					? // a worklet scope holds no inject: the module declares the
						// access API its rewrite calls (src/workletLead.ts)
						workletAccess(names.access)
					: '') +
		// import.meta.resolve answers with the page's URLs: a relative
		// specifier resolves against the module's URL, and a bare or an
		// absolute one goes through the module's own resolve, which the page's
		// import map (its targets routed) answers with a route, read back as
		// the page's URL (and which throws for a bare specifier the map does
		// not have, as natively). ToString as natively: a Symbol throws. A
		// worklet's access API reads no routes back: there a bare specifier
		// comes back as it is
		(type === 'workletModule'
			? `import.meta.url = ${JSON.stringify(url.toString())};import.meta.resolve = (s) => ${BARE_SPECIFIER}.test(s = String(s)) ? s : new URL(s, import.meta.url).href;`
			: isModule
				? `import.meta.url = ${JSON.stringify(url.toString())};import.meta.resolve = ((r) => (s) => ${RELATIVE_SPECIFIER}.test(s = \`\${s}\`) ? new URL(s, import.meta.url).href : ${names.access}.resolved(r(s)))(import.meta.resolve);`
				: '') +
		preamble
	);
}
