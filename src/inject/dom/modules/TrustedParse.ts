import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import type DocumentClient from '../Client';

/**
 * The HTML-parsing Trusted Types sinks the inject does not otherwise write
 * for the page (`Document.parseHTMLUnsafe`, `DOMParser.parseFromString`):
 * under the page's require-trusted-types-for they take a TrustedHTML, and a
 * string is refused with Chrome's TypeError and a violation (judged by
 * Client.trustedValue, src/inject/modules/TrustedTypes.ts). STomp's own
 * parses go through the snapshot DOMParser taken before this wrap, so they
 * are never judged.
 */
export default class TrustedParseModule extends Module<DocumentClient> {
	apply() {
		if (!this.client.scriptFacts.ttActive) return;
		const global = this.client.global as typeof globalThis;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const client = this.client;
		const hook = (
			owner: Record<string, unknown> | undefined,
			name: string,
			sink: string,
		) => {
			const target = owner?.[name];
			if (typeof target !== 'function') return;
			owner![name] = proxyModule.wrapFunction(
				target as Function,
				(fn, that, args) => {
					if (client.trustedTypesRequired() && args.length) {
						// throws Chrome's TypeError and reports the violation where the
						// markup is a string the page's Trusted Types refuse
						const passed = client.trustedValue(
							args[0],
							'TrustedHTML',
							sink,
							() => {},
						);
						const next = [...args];
						next[0] = passed as string;
						return Reflect.apply(fn, that, next);
					}
					return Reflect.apply(fn, that, args);
				},
			);
		};
		hook(
			global.Document as unknown as Record<string, unknown>,
			'parseHTMLUnsafe',
			'Document parseHTMLUnsafe',
		);
		hook(
			global.DOMParser?.prototype as unknown as Record<string, unknown>,
			'parseFromString',
			'DOMParser parseFromString',
		);
	}
}
