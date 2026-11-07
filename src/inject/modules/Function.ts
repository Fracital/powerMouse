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

		const AsyncFunction = (
			new this.client.global.Function(
				'return async () => {}',
			)() as () => Promise<void>
		).constructor as FunctionConstructor;

		const proxyAsyncFunction = functionFactory(AsyncFunction, 'async function');
		const proxyFunction = functionFactory(Function);
		// the generator constructors are reachable the same way
		const GeneratorFunction = (
			new this.client.global.Function(
				'return function* () {}',
			)() as () => unknown
		).constructor as FunctionConstructor;
		const AsyncGeneratorFunction = (
			new this.client.global.Function(
				'return async function* () {}',
			)() as () => unknown
		).constructor as FunctionConstructor;
		for (const [ctor, prefix] of [
			[GeneratorFunction, 'function*'],
			[AsyncGeneratorFunction, 'async function*'],
		] as const) {
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

		Reflect.defineProperty(AsyncFunction.prototype, 'constructor', {
			configurable: true,
			enumerable: false,
			writable: true,
			value: proxyAsyncFunction,
		});

		this.client.global.Function.prototype.constructor = proxyFunction;
		AsyncFunction.prototype.constructor = proxyAsyncFunction;

		this.client.global.Function = proxyFunction;
	}
}
