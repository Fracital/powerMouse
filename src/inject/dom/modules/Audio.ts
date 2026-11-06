import { routeBinary } from '../../../routeURL';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient from '../Client';

export default class AudioModule extends Module<DocumentClient> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;

		this.client.global.Audio = proxyModule.wrapFunction(
			this.client.global.Audio,
			(target, that, args, newTarget) => {
				if (!newTarget) {
					throw new TypeError(
						`Failed to construct 'Worker': Please use the 'Image' operator, this DOM object constructor cannot be called as a function.`,
					);
				}

				if (args[0] !== undefined)
					args[0] = routeBinary(
						new StompURL(
							new URL(args[0], this.client.url.toString()),
							this.client.url,
						),
					);

				return Reflect.construct(target, args, newTarget);
			},
			true,
		);
	}
}
