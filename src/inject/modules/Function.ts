import { modifyJS } from '../../rewriteJS';
import Client from '../Client';
import Module from '../Module';
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
					const [code] = args.splice(-1, 1);
					// the browser's shape of the source the page gave: rewritten as
					// a whole function expression, so `yield` and `await` parse in
					// their own function, and made by the realm's eval at global
					// scope, as the constructor would
					const written = `${prefix} anonymous(${args.map(String).join(',')}\n) {\n${String(code)}\n}`;
					const made = nativeEval(
						modifyJS(
							`(${written})`,
							this.client.url,
							this.client.config,
							'generic',
						),
					);
					// toString shows the source the page gave, not the rewritten body
					if (typeof made === 'function')
						proxyModule.functionStrings.set(made, written);
					return made;
				},
				true,
			);
		};

		// the realm's other function constructors, reached through a function
		// of each kind. A document the page sandboxed without allow-scripts
		// compiles nothing (its script policy refuses eval, sandbox.ts), and
		// neither can its page: those stay as they are there
		const constructorOf = (source: string): FunctionConstructor | null => {
			try {
				return (new this.client.global.Function(source)() as () => unknown)
					.constructor as FunctionConstructor;
			} catch (error) {
				return null;
			}
		};
		const AsyncFunction = constructorOf('return async () => {}');

		const proxyFunction = functionFactory(Function);
		// the generator constructors are reachable the same way
		const GeneratorFunction = constructorOf('return function* () {}');
		const AsyncGeneratorFunction = constructorOf(
			'return async function* () {}',
		);
		for (const [ctor, prefix] of [
			[GeneratorFunction, 'function*'],
			[AsyncGeneratorFunction, 'async function*'],
		] as const) {
			if (!ctor) continue;
			const proxy = functionFactory(ctor, prefix);
			Reflect.defineProperty(ctor.prototype, 'constructor', {
				configurable: true,
				enumerable: false,
				writable: true,
				value: proxy,
			});
		}

		Reflect.defineProperty(
			this.client.global.Function.prototype,
			'constructor',
			{
				configurable: true,
				enumerable: false,
				writable: true,
				value: proxyFunction,
			},
		);

		if (AsyncFunction) {
			const proxyAsyncFunction = functionFactory(
				AsyncFunction,
				'async function',
			);
			Reflect.defineProperty(AsyncFunction.prototype, 'constructor', {
				configurable: true,
				enumerable: false,
				writable: true,
				value: proxyAsyncFunction,
			});
			AsyncFunction.prototype.constructor = proxyAsyncFunction;
		}

		this.client.global.Function.prototype.constructor = proxyFunction;

		this.client.global.Function = proxyFunction;
	}
}
