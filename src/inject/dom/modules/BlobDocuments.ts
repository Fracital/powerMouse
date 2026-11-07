import { modifyHTML } from '../../../rewriteHTML';
import { modifyJS } from '../../../rewriteJS';
import Module from '../../Module';
import ProxyModule, { catchRequiredArguments } from '../../modules/Proxy';
import DocumentClient from '../Client';

const HTML_TYPE = /^\s*text\/html\s*(;|$)/i;
// the JavaScript MIME type essences (HTML "JavaScript MIME type")
const JS_TYPE =
	/^\s*(?:application\/(?:x-)?(?:ecma|java)script|text\/(?:(?:x-)?(?:ecma|java)script|javascript1\.[0-5]|jscript|livescript))\s*(;|$)/i;

/**
 * A document the page builds itself (`new Blob([html], { type: 'text/html' })`,
 * shown from a blob: URL in a frame or a window) is one nothing fetched, so
 * the service worker never sees it. Its contents are wrapped in the shell at
 * construction, with the page as its URL, so the document runs injected and
 * rewritten like a fetched one. Binary parts (an ArrayBuffer, a typed array)
 * are decoded with the type's charset (UTF-8 by default) first; a blob whose
 * bytes do not decode, or one built from another Blob (its bytes are not
 * readable synchronously), is left as it is.
 *
 * A script blob (`new Blob([js], { type: 'text/javascript' })`, loaded as a
 * script's src or imported by a worker) is rewritten the same way: as a
 * classic script, or as a module when only that parses.
 */
export default class BlobDocumentsModule extends Module<DocumentClient> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global;

		const wrap = (parts: unknown, options: unknown): unknown => {
			if (typeof options !== 'object' || options === null) return parts;
			const type = String((options as BlobPropertyBag).type ?? '');
			const isHTML = HTML_TYPE.test(type);
			if (!isHTML && !JS_TYPE.test(type)) return parts;
			let list: unknown[];
			try {
				list = [...(parts as Iterable<unknown>)];
			} catch (error) {
				return parts;
			}
			const charset =
				/;\s*charset=([\w-]+)/i.exec(
					String((options as BlobPropertyBag).type),
				)?.[1] ?? 'utf-8';
			let decoder: TextDecoder;
			try {
				decoder = new TextDecoder(charset, { fatal: true });
			} catch (error) {
				return parts;
			}
			const text: string[] = [];
			for (const part of list) {
				if (typeof part === 'string') text.push(part);
				else if (part instanceof ArrayBuffer || ArrayBuffer.isView(part)) {
					try {
						text.push(decoder.decode(part as BufferSource, { stream: true }));
					} catch (error) {
						return parts;
					}
				} else return parts;
			}
			try {
				text.push(decoder.decode());
			} catch (error) {
				return parts;
			}
			const source = text.join('');
			if (isHTML)
				return [modifyHTML(source, this.client.url, this.client.config, true)];
			// a script that does not parse comes back as it was: then it may be
			// a module (its `import` / `export` are the usual reason)
			let rewritten = modifyJS(source, this.client.url, this.client.config);
			if (rewritten === source)
				rewritten = modifyJS(
					source,
					this.client.url,
					this.client.config,
					'genericModule',
				);
			return [rewritten];
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
