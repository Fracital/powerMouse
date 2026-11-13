import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import type DocumentClient from '../Client';

/**
 * The page's own script-src governs WebAssembly compilation: without
 * 'unsafe-eval' (or 'wasm-unsafe-eval', which allows only compilation) the
 * browser refuses it with a CompileError and reports it (measured, Chrome 152
 * and 156). The browser never gets the page's script-src (src/csp.ts
 * browserPolicy), so the inject enforces it against the page's own
 * compilation here. Only `WebAssembly.compile` and the `WebAssembly.Module`
 * constructor are wrapped: the streaming and `instantiate` forms are left
 * alone, since the epoxy transport's own wasm-bindgen glue instantiates
 * through them and must never be refused (STomp's rewriter wasm compiles with
 * native methods captured before this wrap, src/wasm/module.ts; the content
 * blocker instantiates an already-compiled Module, which is not gated).
 */
export default class WebAssemblyPolicyModule extends Module<DocumentClient> {
	apply() {
		const global = this.client.global as typeof globalThis;
		const wasm = global.WebAssembly as
			(typeof WebAssembly & Record<string, unknown>) | undefined;
		if (!wasm) return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const client = this.client;
		// WebAssembly.compile rejects
		const compile = wasm.compile as unknown;
		if (typeof compile === 'function')
			(wasm as Record<string, unknown>).compile = proxyModule.wrapFunction(
				compile as Function,
				(fn, that, args) => {
					const refusal = client.codeEval('wasm-compile', '');
					if (refusal?.error) return global.Promise.reject(refusal.error);
					return Reflect.apply(fn, that, args);
				},
			);
		// the Module constructor throws. wrapFunction('callable') keeps its
		// prototype and statics (standIn), so wasm the policy allows is unaffected
		const ModuleCtor = wasm.Module as Function | undefined;
		if (typeof ModuleCtor === 'function')
			(wasm as Record<string, unknown>).Module = proxyModule.wrapFunction(
				ModuleCtor,
				(fn, that, args, newTarget) => {
					const refusal = client.codeEval('wasm-module', '');
					if (refusal?.error) throw refusal.error;
					return newTarget
						? Reflect.construct(fn as new () => object, args, newTarget)
						: Reflect.apply(fn, that, args);
				},
				'callable',
			);
	}
}
