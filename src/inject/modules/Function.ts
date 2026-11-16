import Client from '../Client';
import Module from '../Module';
import { modifyJS } from '../rewriter';
import { trustedFunction, trustedScript } from '../trusted';
import ProxyModule from './Proxy';

export default class FunctionModule extends Module<Client> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;

		// the realm's own eval, as it is before any page code (Access tags it
		// but leaves it in place)
		const nativeEval = this.client.global.eval;
		const functionFactory = (
			ctor: FunctionConstructor,
			prefix = 'function',
		): FunctionConstructor => {
			return proxyModule.wrapFunction(
				ctor,
				(target, that, args, newTarget) => {
					if (args.length === 0)
						return newTarget
							? Reflect.construct(target, args, newTarget)
							: Reflect.apply(target, that, args);
					const given = [...args];
					const [code] = args.splice(-1, 1);
					// the browser's shape of the source the page gave: rewritten as
					// a whole function expression, so `yield` and `await` parse in
					// their own function, and made by the realm's eval at global
					// scope, as the constructor would
					const written = `${prefix} anonymous(${args.map(String).join(',')}\n) {\n${String(code)}\n}`;
					// the page's Trusted Types judge that source first (as Chrome
					// does); then its script-src refuses code made from a string,
					// Chrome's violation sample being the whole function expression
					// it compiles, parentheses and all (src/csp.ts codeEval)
					if (
						this.client.trustedValue(
							`(${written})`,
							'TrustedScript',
							'Function',
							() =>
								newTarget
									? Reflect.construct(target, given, newTarget)
									: Reflect.apply(target, that, given),
						) === null
					)
						return undefined;
					const refusal = this.client.codeEval('Function', `(${written})`);
					if (refusal) {
						if (refusal.error) throw refusal.error;
						return undefined;
					}
					const rewritten = modifyJS(
						`(${written})`,
						this.client.baseURL,
						this.client.config,
						'generic',
					);
					this.client.noteCodeSample(rewritten, `(${written})`);
					const made = nativeEval(trustedScript(rewritten));
					// toString shows the source the page gave, not the rewritten body
					if (typeof made === 'function') {
						proxyModule.functionStrings.set(made, written);
						// `class Callable extends Function`, `Reflect.construct(
						// Function, [code], Other)`: the function is made with the
						// prototype of what was constructed, as natively
						if (newTarget && newTarget !== target) {
							const prototype = (newTarget as { prototype?: unknown })
								.prototype;
							if (
								((typeof prototype === 'object' && prototype !== null) ||
									typeof prototype === 'function') &&
								prototype !== Reflect.getPrototypeOf(made)
							)
								Reflect.setPrototypeOf(made, prototype as object);
						}
					}
					return made;
				},
				'callable',
			);
		};

		// the realm's other function constructors, reached through a function
		// of each kind. A document the page sandboxed without allow-scripts
		// compiles nothing (its script policy refuses eval, sandbox.ts), and
		// neither can its page: those stay as they are there
		// (a document whose policy refuses code made from a string, src/csp.ts:
		// its own realm's constructors from the bundle's own functions, which
		// are its realm's, and none for another realm's, whose page cannot
		// compile either; the browser would report every attempt)
		const ownRealm = this.client.global.Function === Function;
		const constructorOf = (source: string): FunctionConstructor | null => {
			if (!this.client.scriptFacts.evaluates)
				return ownRealm
					? (
							Reflect.getPrototypeOf(
								{
									'return async () => {}': async () => {},
									'return function* () {}': function* () {},
									'return async function* () {}': async function* () {},
								}[source] ?? (() => {}),
							) as { constructor: FunctionConstructor }
						).constructor
					: null;
			try {
				return (
					(
						trustedFunction(this.client.global, [], source) ??
						new this.client.global.Function(source)
					)() as () => unknown
				).constructor as FunctionConstructor;
			} catch (error) {
				return null;
			}
		};
		const AsyncFunction = constructorOf('return async () => {}');

		// each constructor is its prototype's `constructor` and inherits from
		// the page's Function, as natively (ProxyModule.standIn)
		// The realm's own Function, also where the realm is not the bundle's
		// (a frame the parent read before it loaded, which the parent's
		// bundle hooks): the bundle's Function was wrapped there, which made
		// the frame's wrapper the constructor of the PARENT's
		// Function.prototype. From then on `(function () {}).constructor` in
		// the parent was not its Function, and code it made ran for the
		// frame's window, whatever site that window went on to show. What
		// the frame's page reaches of the bundle's is the frame's to look at
		// instead (ProxyModule.adopt: its wrappers and the access API have
		// the frame's Function.prototype and Object.prototype above them),
		// so `api.constructor.constructor` is the frame's Function
		// (helper-seal suite).
		const proxyFunction = functionFactory(this.client.global.Function);
		// the generator constructors are reachable the same way
		const GeneratorFunction = constructorOf('return function* () {}');
		const AsyncGeneratorFunction = constructorOf(
			'return async function* () {}',
		);
		for (const [ctor, prefix] of [
			[GeneratorFunction, 'function*'],
			[AsyncGeneratorFunction, 'async function*'],
			[AsyncFunction, 'async function'],
		] as const)
			if (ctor) functionFactory(ctor, prefix);

		this.client.global.Function = proxyFunction;
	}
}
