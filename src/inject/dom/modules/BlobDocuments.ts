import { modifyHTML } from '../../../rewriteHTML';
import Module from '../../Module';
import ProxyModule, { catchRequiredArguments } from '../../modules/Proxy';
import DocumentClient from '../Client';

const HTML_TYPE = /^\s*text\/html\s*(;|$)/i;

/**
 * A document the page builds itself (`new Blob([html], { type: 'text/html' })`,
 * shown from a blob: URL in a frame or a window) is one nothing fetched, so
 * the service worker never sees it. Its contents are wrapped in the shell at
 * construction, with the page as its URL, so the document runs injected and
 * rewritten like a fetched one. Only string parts are wrapped: binary parts
 * are left as they are (a known limitation).
 */
export default class BlobDocumentsModule extends Module<DocumentClient> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global;

		const wrap = (parts: unknown, options: unknown): unknown => {
			if (
				typeof options !== 'object' ||
				options === null ||
				!HTML_TYPE.test(String((options as BlobPropertyBag).type ?? ''))
			)
				return parts;
			let list: unknown[];
			try {
				list = [...(parts as Iterable<unknown>)];
			} catch (error) {
				return parts;
			}
			if (!list.every((part) => typeof part === 'string')) return parts;
			return [
				modifyHTML(list.join(''), this.client.url, this.client.config, true),
			];
		};

		const globals = global as unknown as Record<string, unknown>;
		for (const name of ['Blob', 'File'] as const) {
			const ctor = globals[name];
			if (typeof ctor !== 'function') continue;
			globals[name] = proxyModule.wrapFunction(
				ctor as new (...args: unknown[]) => Blob,
				(target, that, args, newTarget) => {
					if (!newTarget)
						throw new TypeError(
							`Failed to construct '${name}': Please use the 'new' operator, this DOM object constructor cannot be called as a function.`,
						);
					if (name === 'File')
						catchRequiredArguments(args.length, 2, name, 'constructor');
					// Blob(parts, options); File(parts, name, options)
					const optionsAt = name === 'File' ? 2 : 1;
					if (args.length) args[0] = wrap(args[0], args[optionsAt]);
					return Reflect.construct(target, args, newTarget);
				},
				true,
			);
		}
	}
}
