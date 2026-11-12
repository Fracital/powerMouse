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
					// (the page's Trusted Types judge that source, as Chrome does)
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
					const rewritten = modifyJS(
						`(${written})`,
						this.client.baseURL,
						this.client.config,
						'generic',
					);
					this.client.noteCodeSample(rewritten, `(${written})`);
					const made = nativeEval(trustedScript(rewritten));
					// toString shows the source the page gave, not the rewritten body
					if (typeof made === 'function')
						proxyModule.functionStrings.set(made, written);
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
		// the bundle's own Function: a document the parent's bundle was
		// injected into (a frame the parent read before it loaded) reaches
		// the parent's realm through `api.constructor.constructor`, which
		// must make the child's functions too (helper-seal suite)
		const proxyFunction = functionFactory(Function);
		const realmPrototype = this.client.global.Function.prototype;
		if (realmPrototype !== Function.prototype)
			Reflect.defineProperty(realmPrototype, 'constructor', {
				...Reflect.getOwnPropertyDescriptor(realmPrototype, 'constructor'),
				value: proxyFunction,
			});
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
