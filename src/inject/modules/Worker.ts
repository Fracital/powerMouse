import { routeJS } from '../../rewriteJS';
import StompURL from '../../StompURL';
import Client from '../Client';
import Module from '../Module';
import ProxyModule, { catchRequiredArguments } from './Proxy';

export default class WorkerModule extends Module<Client> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;

		this.client.global.Worker = proxyModule.wrapFunction(
			this.client.global.Worker,
			(target, that, args, newTarget) => {
				if (!newTarget) {
					throw new TypeError(
						`Failed to construct 'Worker': Please use the 'new' operator, this DOM object constructor cannot be called as a function.`,
					);
				}

				catchRequiredArguments(args.length, 1, 'Worker', 'constructor');

				const isModule =
					typeof args[1] === 'object' &&
					(args[1] as WorkerOptions).type === 'module';

				args[0] = routeJS(
					new StompURL(
						new URL(String(args[0]), this.client.url.toString()),
						this.client.url,
					),
					this.client.url,
					this.client.config,
					isModule ? 'workerModule' : 'worker',
				);

				const worker: Worker = Reflect.construct(target, args, newTarget);

				this.client.provisionWorkerTransport(worker);

				return worker;
			},
			true,
		);
	}
}
