import Client from '../Client';
import Module from '../Module';
import { modifyJS } from '../rewriter';
import ProxyModule from './Proxy';

/**
 * `setTimeout("code", ms)` compiles its string like a classic script, so it
 * must be rewritten like one or it sees the proxy's location and the real
 * top. Function callbacks pass through untouched.
 */
export default class TimersModule extends Module<Client> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;

		for (const name of ['setTimeout', 'setInterval'] as const) {
			const global = this.client.global as unknown as Record<string, Function>;
			global[name] = proxyModule.wrapFunction(
				global[name],
				(target, that, args) => {
					if (args.length && typeof args[0] !== 'function')
						args[0] = modifyJS(
							String(args[0]),
							this.client.baseURL,
							this.client.config,
							'generic',
						);
					return Reflect.apply(target, that, args);
				},
			);
		}
	}
}
