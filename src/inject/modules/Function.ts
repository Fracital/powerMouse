import { modifyJS } from '../../rewriteJS';
import Client from '../Client';
import Module from '../Module';
import ProxyModule from './Proxy';

export default class FunctionModule extends Module<Client> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;

		const functionFactory = (
			ctor: FunctionConstructor,
			prefix = 'function',
		): FunctionConstructor => {
			return proxyModule.wrapFunction(
				ctor,
				(target, that, args, newTarget) => {
					let written: string | null = null;
					if (args.length !== 0) {
						let [code] = args.splice(-1, 1);
						code = String(code);
						written = `${prefix} anonymous(${args.map(String).join(',')}\n) {\n${code}\n}`;
						code = modifyJS(
							code,
							this.client.url,
							this.client.config,
							'generic',
						);
						args.push(code);
					}

					const made = newTarget
						? Reflect.construct(target, args, newTarget)
						: Reflect.apply(target, that, args);
					// toString shows the source the page gave, in the browser's shape,
					// not the rewritten body
					if (written !== null && typeof made === 'function')
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
