import StompURL from '../../../StompURL';
import { routeHTML } from '../../../rewriteHTML';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient from '../Client';

export default class HistoryModule extends Module<DocumentClient> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;

		function updateState(
			this: HistoryModule,
			target: typeof history.pushState,
			that: History,
			args: any[]
		) {
			if (args[2] !== undefined)
				args[2] = routeHTML(
					new StompURL(
						new URL(args[2], this.client.url.toString()),
						this.client.url
					),
					this.client.url,
					this.client.config
				);

			return Reflect.apply(target, that, args);
		}

		this.client.global.History.prototype.pushState = proxyModule.wrapFunction(
			this.client.global.History.prototype.pushState,
			updateState.bind(this)
		);

		this.client.global.History.prototype.replaceState =
			proxyModule.wrapFunction(
				this.client.global.History.prototype.replaceState,
				updateState.bind(this)
			);
	}
}
