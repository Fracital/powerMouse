import { modifyJS } from '../../rewriteJS';
import Client from '../Client';
import Module from '../Module';
import ProxyModule from './Proxy';

export default class FunctionModule extends Module<Client> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;

		const functionFactory = (
			ctor: FunctionConstructor
		): FunctionConstructor => {
			return proxyModule.wrapFunction(
				ctor,
				(target, that, args, newTarget) => {
					if (args.length !== 0) {
						let [code] = args.splice(-1, 1);
						code = String(code);
						code = modifyJS(
							code,
							this.client.url,
							this.client.config,
							'generic'
						);
						args.push(code);
					}

					return newTarget
						? Reflect.construct(target, args, newTarget)
						: Reflect.apply(target, that, args);
				},
				true
			);
		};

		const proxyAsyncFunction = functionFactory(AsyncFunction);
		const proxyFunction = functionFactory(Function);

		Reflect.defineProperty(Function.prototype, 'constructor', {
			configurable: true,
			enumerable: false,
			writable: true,
			value: proxyFunction,
		});

		Reflect.defineProperty(AsyncFunction.prototype, 'constructor', {
			configurable: true,
			enumerable: false,
			writable: true,
			value: proxyAsyncFunction,
		});

		Function.prototype.constructor = proxyFunction;
		AsyncFunction.prototype.constructor = proxyAsyncFunction;

		global.Function = proxyFunction;
	}
}
