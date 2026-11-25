import { keepFunction } from '../../functionSource';
import Client from '../Client';
import Module from '../Module';
import { modifyJS } from '../rewriter';
import { trustedFunction, trustedScript } from '../trusted';
import ProxyModule from './Proxy';

export default class FunctionModule extends Module<Client> {
	apply() {
		const client = this.client;
		const global = client.global;
		const proxyModule = client.getModule(ProxyModule)!;

		// the realm's own eval, as it is before any page code (Access tags it
		// but leaves it in place)
		const nativeEval = global.eval;
		// (taken before any page code: a bound function of newTarget, below)
		const bind = Function.prototype.bind;
		// A newTarget whose `prototype` is no object: the function's prototype
		// is the constructor's intrinsic of newTarget's realm
		// (GetPrototypeFromConstructor), which only the engine knows. It is
		// asked of the native constructor with no code, through a bound
		// function of newTarget whose own prototype chain is empty: no
		// `prototype` is found on it (the page's getter is not read again),
		// and the bound function's realm is newTarget's
		const realmPrototype = (
			target: FunctionConstructor,
			newTarget: Function,
		): object | null => {
			try {
				const bound = Reflect.apply(bind, newTarget, []) as Function;
				Reflect.setPrototypeOf(bound, null);
				return Reflect.getPrototypeOf(Reflect.construct(target, [], bound));
			} catch (error) {
				return null;
			}
		};
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
						client.trustedValue(
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
					const refusal = client.codeEval('Function', `(${written})`);
					if (refusal) {
						if (refusal.error) throw refusal.error;
						return undefined;
					}
					const rewritten = modifyJS(
						`(${written})`,
						client.codeBaseURL(written),
						client.config,
						'generic',
					);
					client.noteCodeSample(rewritten, `(${written})`);
					const made = nativeEval(trustedScript(rewritten));
					// toString shows the source the page gave, not the rewritten body
					if (typeof made === 'function') {
						proxyModule.functionStrings.set(made, written);
						// (and the functions it makes read theirs while it lives)
						keepFunction(made);
						// `class Callable extends Function`, `Reflect.construct(
						// Function, [code], Other)`: the function is made with the
						// prototype of what was constructed, as natively
						if (newTarget && newTarget !== target) {
							const prototype = (newTarget as { prototype?: unknown })
								.prototype;
							const wanted =
								(typeof prototype === 'object' && prototype !== null) ||
								typeof prototype === 'function'
									? (prototype as object)
									: realmPrototype(target, newTarget);
							if (wanted && wanted !== Reflect.getPrototypeOf(made))
								Reflect.setPrototypeOf(made, wanted);
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
		const ownRealm = global.Function === Function;
		const constructorOf = (source: string): FunctionConstructor | null => {
			if (!client.scriptFacts.evaluates)
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
						trustedFunction(global, [], source) ?? new global.Function(source)
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
		const proxyFunction = functionFactory(global.Function);
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

		global.Function = proxyFunction;
	}
}
