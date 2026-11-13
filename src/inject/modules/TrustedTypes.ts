import type Client from '../Client';
import Module from '../Module';
import { TRUSTED_KINDS } from '../trusted';
import ProxyModule from './Proxy';

const MEMBERS = ['createHTML', 'createScript', 'createScriptURL'] as const;
// taken at load, before the Timers module wraps setTimeout
const nativeSetTimeout = globalThis.setTimeout;

/**
 * The page's Trusted Types at the sinks the inject writes for it (an
 * innerHTML, a script's text, eval) and the policies it makes. The browser
 * gets no `require-trusted-types-for` or `trusted-types` of the page's
 * (src/csp.ts browserPolicy): STomp's own Function, eval and HTML/script
 * sinks must never be made to take trusted values, and its own policy never
 * activates (src/inject/trusted.ts `name` stays null). So the inject
 * enforces the page's Trusted Types against the page's own sinks and policy
 * names itself, as Chrome does (measured, Chrome 152 and 156): a trusted
 * value of the sink's type passes, a string goes to the page's default
 * policy with Chrome's arguments and what it returns is the value (for eval
 * and Function only its identical string), and what is left is refused with
 * Chrome's own TypeError or EvalError and a trusted violation. It installs
 * only where the page's policy has a Trusted Types directive
 * (scriptFacts.ttActive).
 */
export default class TrustedTypesModule extends Module<Client> {
	apply() {
		if (!this.client.scriptFacts.ttActive) return;
		const global = this.client.global as typeof globalThis;
		const factory = (global as { trustedTypes?: object }).trustedTypes;
		const prototype = factory && Reflect.getPrototypeOf(factory);
		if (!prototype) return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const owned = prototype as unknown as Record<string, Function>;
		const is = [owned.isHTML, owned.isScript, owned.isScriptURL];
		const text = TRUSTED_KINDS.map(
			(kind) =>
				(global as unknown as Record<string, { prototype: object }>)[kind]
					?.prototype as { toString: () => string } | undefined,
		).map((proto) => proto?.toString);
		/** the page's default policy's callbacks, by kind */
		let callbacks: unknown[] = [];
		/** whether the page made a default policy at all (the refusal message names it) */
		let defaultMade = false;
		/** the policy names the page has made, for the trusted-types directive's duplicate rule */
		const made = new Set<string>();
		/** the page's own script text that reaches a sink the inject writes (a Text node), which its default policy is not asked of */
		const approved = new Set<string>();

		this.client.trustedJavascript = (page, _routed, proceed) => {
			const required = this.client.trustedTypesRequired();
			if (!required) return true;
			// a javascript: navigation is async, as is its Trusted Types judgment:
			// the inject does both after the page's call returns (so the default
			// policy's call is not seen by the code that set location), then
			// navigates to the rewrite or reports the refusal
			nativeSetTimeout(() => {
				const callback = callbacks[1];
				let allowed = false;
				if (typeof callback === 'function')
					try {
						const made: unknown = Reflect.apply(callback, undefined, [
							page,
							'TrustedScript',
							'Location href',
						]);
						allowed = made !== null && made !== undefined;
					} catch (error) {
						allowed = false;
					}
				if (allowed) proceed();
				else if (required === 'enforce')
					this.client.reportTrustedSink('Location href', page);
				else {
					this.client.reportTrustedTypes('Location href', page);
					proceed();
				}
			});
			return false;
		};
		this.client.trustedApprove = (value) => {
			if (!callbacks[1]) return;
			approved.add(`1${value}`);
			if (approved.size > 64) approved.delete(approved.values().next().value!);
		};

		// a createPolicy the page's trusted-types directive refuses throws
		// Chrome's TypeError and reports a trusted-types-policy violation; the
		// default policy's callbacks are captured for the sinks (no browser
		// Trusted Types asks them, so they are the page's own, called directly)
		owned.createPolicy = proxyModule.wrapFunction(
			owned.createPolicy,
			(target, that, args) => {
				const name = `${args[0]}`;
				const refusals = this.client.refusedTrustedPolicy(name, made);
				// each refusing policy reports (trusted where it enforces); an
				// enforced one also throws, and then the policy is not made
				let enforced: string | null = null;
				for (const { policy, message } of refusals) {
					this.client.reportTrustedPolicy(policy, name);
					if (
						enforced === null &&
						(policy as { disposition?: string }).disposition === 'enforce'
					)
						enforced = message;
				}
				if (enforced !== null) throw new global.TypeError(enforced);
				made.add(name);
				const options = args[1];
				if (
					name === 'default' &&
					typeof options === 'object' &&
					options !== null
				) {
					callbacks = MEMBERS.map(
						(member) => (options as Record<string, unknown>)[member],
					);
					defaultMade = true;
				}
				return Reflect.apply(target, that, args);
			},
		);

		this.client.trustedCheck = (
			value,
			type,
			sink,
			refuse,
			convert,
			attribute,
		) => {
			const required = this.client.trustedTypesRequired();
			if (!required) return convert(value);
			const kind = TRUSTED_KINDS.indexOf(type);
			// a trusted value of the sink's type passes as its own string
			if (Reflect.apply(is[kind], factory, [value]))
				return Reflect.apply(text[kind]!, value, []) as string;
			const written = convert(value);
			// code made from a string runs only as the policy's identical string
			const code = sink === 'eval' || sink === 'Function';
			// the inject's own script text that lands as a Text node: judged as
			// the script runs, the page's default policy is not asked of it
			if (approved.delete(`${kind}${written}`)) return written;
			const callback = callbacks[kind];
			const hadCallback = typeof callback === 'function';
			let threw: { error: unknown } | null = null;
			let returnedNull = false;
			if (hadCallback)
				try {
					const result: unknown = Reflect.apply(callback, undefined, [
						written,
						type,
						sink,
					]);
					if (result !== null && result !== undefined) {
						const string = String(result);
						// a code sink runs only the identical string; any other sink
						// takes what the policy returns
						if (!code || string === written) return string;
					} else returnedNull = true;
				} catch (error) {
					threw = { error };
				}
			if (required === 'report') {
				// report-only never blocks: the policy's throw still throws, else
				// the sink goes on with the page's value and the inject reports it
				if (threw) throw code ? this.#codeError(sink, type) : threw.error;
				this.client.reportTrustedTypes(sink, written);
				return written;
			}
			// enforce: the policy's throw propagates (no violation); otherwise
			// Chrome's TypeError/EvalError and, where no policy answered, a
			// trusted violation
			if (threw) throw code ? this.#codeError(sink, type) : threw.error;
			const event = returnedNull || !hadCallback;
			const tail = returnedNull
				? " and the 'default' policy failed to execute."
				: !hadCallback && defaultMade
					? ` and no 'default' policy for '${type}' has been defined.`
					: '.';
			if (event) this.client.reportTrustedSink(sink, written);
			throw this.client.trustedTypeError(sink, type, tail, !!attribute);
		};
	}

	#codeError(sink: string, type: string): Error {
		return this.client.trustedTypeError(sink, type, '', false);
	}
}
