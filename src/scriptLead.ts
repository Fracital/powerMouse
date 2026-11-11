// What runs before a script's own code. It needs no parser, so the inject's
// light rewriter library (src/rewriterLight.ts) builds it for the wasm
// module without holding the JavaScript rewriter (src/rewriteJS.ts), which
// builds the same text from here.
import type { Config } from './config';
import { helperNames } from './helperNames';
import { injectWorkerJS } from './routeURL';
import { BARE_SPECIFIER, type ScriptType } from './scriptRoutes';
import type StompURL from './StompURL';

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
	const isModule = type === 'genericModule' || type === 'workerModule';
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
		(type === 'workerModule'
			? `if (!(${JSON.stringify(names.client)} in globalThis)) {
	let held;
	if (!globalThis.createClient) {
		held = [];
		const hold = (event) => {
			event.stopImmediatePropagation();
			held.push(event);
		};
		addEventListener('message', hold);
		addEventListener('connect', hold);
		try {
			(0, eval)((await (await fetch(${bundle})).text()) + '\\n//# sourceURL=' + new globalThis.URL(${bundle}, globalThis.location.href).href);
		} finally {
			removeEventListener('message', hold);
			removeEventListener('connect', hold);
		}
	}
	createClient(${JSON.stringify(config)}, ${JSON.stringify(url.codec.key)}, held);
}
if (!${names.client}.applied)
	${names.client}.apply();`
			: isWorker
				? `if (!(${JSON.stringify(names.client)} in globalThis) && !globalThis.createClient)
	importScripts(${JSON.stringify(injectWorkerJS(url, config))});

if (!(${JSON.stringify(names.client)} in globalThis))
	createClient(${JSON.stringify(config)}, ${JSON.stringify(url.codec.key)});

if (!${names.client}.applied) 
	${names.client}.apply();`
				: '') +
		// import.meta.resolve answers with the page's URLs; a bare specifier
		// belongs to the import map and comes back as it is
		(isModule
			? `import.meta.url = ${JSON.stringify(url.toString())};import.meta.resolve = (s) => ${BARE_SPECIFIER}.test(s = String(s)) ? s : new URL(s, import.meta.url).href;`
			: '') +
		preamble
	);
}
