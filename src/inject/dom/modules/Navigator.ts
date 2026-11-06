import { routeXHR } from '../../../routeURL';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient from '../Client';

export default class NavigatorModule extends Module<DocumentClient> {
	apply() {
		if ('serviceWorker' in this.client.global.Navigator.prototype) {
			delete (this.client.global as any).ServiceWorkerContainer;
			delete (this.client.global as any).ServiceWorkerRegistration;
			delete (this.client.global.Navigator.prototype as any).serviceWorker;
		}

		const proxyModule = this.client.getModule(ProxyModule)!;

		if (this.client.global.Navigator.prototype.sendBeacon)
			this.client.global.Navigator.prototype.sendBeacon =
				proxyModule.wrapFunction(
					this.client.global.Navigator.prototype.sendBeacon,
					(target, that, args) => {
						args[0] = routeXHR(
							new StompURL(
								new URL(args[0], this.client.url.toString()),
								this.client.url,
							),
						);

						return Reflect.apply(target, that, args);
					},
				);
	}
}
