import type Client from '../Client';
import Module from '../Module';
import { TRUSTED_KINDS, trustedTypesUsed } from '../trusted';
import ProxyModule from './Proxy';

const MEMBERS = ['createHTML', 'createScript', 'createScriptURL'];

/** what the page's default policy made of a value the inject asked it of */
type Outcome = { value: unknown } | { error: unknown };

/**
 * The page's Trusted Types at the sinks the inject writes for it (an
 * innerHTML, a script's text, eval): the browser judges only the values
 * the inject writes, its own trusted ones (src/inject/trusted.ts), so the
 * inject judges the page's value first, as Chrome does (measured, Chrome
 * 152 and 156): a trusted value of the sink's type is let through, a
 * string goes to the page's default policy with Chrome's arguments (the
 * value, the type, the sink's name) and what it returns is the value,
 * and what is left is refused. A refusal is the browser's own: the
 * native sink is handed the page's value, with the default policy's
 * answer replayed to it rather than asked again, and throws Chrome's
 * TypeError (or EvalError) and reports the page's sink and value itself.
 * A report-only policy reports it (the inject's event: the browser would
 * report the inject's rewrite) and the page's value goes on.
 */
export default class TrustedTypesModule extends Module<Client> {
	apply() {
		// the browser enforces no Trusted Types policy of the page's
		// (src/csp.ts): STomp's own Function, eval and HTML/script sinks must
		// not be made to take trusted values. The inject emulates the page's
		// require-trusted-types-for for the page's own sinks only where its
		// policy sets one (scriptFacts.rtt); with none it installs nothing.
		if (!this.client.scriptFacts.rtt) return;
		const global = this.client.global as typeof globalThis;
		const factory = (global as { trustedTypes?: object }).trustedTypes;
		const prototype = factory && Reflect.getPrototypeOf(factory);
		if (!prototype) return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const client = this.client;
		const owned = prototype as unknown as Record<string, Function>;
		const is = [owned.isHTML, owned.isScript, owned.isScriptURL];
		const text = TRUSTED_KINDS.map(
			(kind) =>
				(global as unknown as Record<string, { prototype: object }>)[kind]
					?.prototype as { toString: () => string } | undefined,
		).map((proto) => proto?.toString);
		/** the page's default policy's callbacks, by kind */
		let callbacks: unknown[] = [];
		/** what the default policy answers the browser next for a value (kind + value), already asked */
		const replays = new Map<string, Outcome>();
		/**
		 * The inject's own scripts' text (and javascript: URLs' code) that
		 * reaches a sink the browser judges as it runs: a script whose text
		 * lands as a Text node, which nothing can make trusted. Only a
		 * default policy lets it run, and the page's is not asked of it.
		 */
		const approved = new Set<string>();
		/** the page's code of each javascript: URL's rewrite the browser judges (trustedJavascript) */
		const javascripts = new Map<string, [string, (() => unknown) | null]>();
		this.client.trustedJavascript = (page, routed, refuse) => {
			const required = trustedTypesUsed()
				? this.client.trustedTypesRequired()
				: null;
			if (!required) return true;
			// with a default policy, the browser asks it of the rewrite as it
			// navigates (later, measured): its wrapper asks it of the page's code
			if (typeof callbacks[1] === 'function') {
				javascripts.set(`1${routed}`, [
					page,
					required === 'enforce' ? refuse : null,
				]);
				if (javascripts.size > 16)
					javascripts.delete(javascripts.keys().next().value!);
				return true;
			}
			if (required === 'report') {
				this.client.reportTrustedTypes('Location href', page);
				return true;
			}
			refuse();
			return false;
		};
		this.client.trustedApprove = (value) => {
			if (!callbacks[1]) return;
			approved.add(`1${value}`);
			if (approved.size > 64) approved.delete(approved.values().next().value!);
		};
		// the default policy's callbacks are the page's behind a wrapper that
		// gives the browser an answer the inject already had of the page
		owned.createPolicy = proxyModule.wrapFunction(
			owned.createPolicy,
			(target, that, args) => {
				const options = args[1];
				if (
					args[0] !== 'default' ||
					typeof options !== 'object' ||
					options === null
				)
					return Reflect.apply(target, that, args);
				const page: unknown[] = [];
				const given = {};
				// read when the browser reads them, in its order
				MEMBERS.forEach((member, kind) =>
					Reflect.defineProperty(given, member, {
						get: () => {
							const callback = (options as Record<string, unknown>)[member];
							if (typeof callback !== 'function') return callback;
							page[kind] = callback;
							return function (this: unknown, ...values: unknown[]) {
								const key = `${kind}${values[0]}`;
								if (approved.delete(key)) return values[0];
								// a javascript: URL's rewrite: the page's code is judged
								const javascript = javascripts.get(key);
								if (javascript && values[2] === 'Location href') {
									javascripts.delete(key);
									const [page, refuse] = javascript;
									const made: unknown = Reflect.apply(callback, this, [
										page,
										...values.slice(1),
									]);
									if (made !== null && made !== undefined) return values[0];
									// reported only: the rewrite goes on
									if (!refuse) {
										client.reportTrustedTypes('Location href', page);
										return values[0];
									}
									// refused: the rewrite does nothing, and the browser is
									// handed the page's URL, which it refuses and reports
									// with the answer replayed
									replays.set(`1${page}`, { value: made });
									refuse();
									return 'void 0';
								}
								const replay = replays.get(key);
								if (!replay) return Reflect.apply(callback, this, values);
								replays.delete(key);
								if ('error' in replay) throw replay.error;
								return replay.value;
							};
						},
					}),
				);
				const made = Reflect.apply(target, that, ['default', given]);
				callbacks = page;
				return made;
			},
		);
		this.client.trustedCheck = (value, type, sink, refuse, convert) => {
			const required = trustedTypesUsed()
				? this.client.trustedTypesRequired()
				: null;
			if (!required) return convert(value);
			const kind = TRUSTED_KINDS.indexOf(type);
			if (Reflect.apply(is[kind], factory, [value]))
				return Reflect.apply(text[kind]!, value, []) as string;
			const written = convert(value);
			// code made from a string runs only as the policy's identical string
			const code = sink === 'eval' || sink === 'Function';
			const callback = callbacks[kind];
			let outcome: Outcome | null = null;
			if (typeof callback === 'function')
				try {
					const made: unknown = Reflect.apply(callback, undefined, [
						written,
						type,
						sink,
					]);
					outcome = { value: made };
					if (made !== null && made !== undefined) {
						const result = String(made);
						if (!code || result === written) return result;
					}
				} catch (error) {
					if (!code) throw error;
					outcome = { error };
				}
			if (required === 'enforce') {
				const key = `${kind}${written}`;
				if (outcome) {
					replays.set(key, outcome);
					// (a script the page inserts is judged as it is inserted, in this task)
					queueMicrotask(() => replays.delete(key));
				}
				refuse();
				return null;
			}
			if (outcome && 'error' in outcome) throw outcome.error;
			this.client.reportTrustedTypes(sink, written);
			return written;
		};
	}
}
