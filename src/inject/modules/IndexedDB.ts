import Client from '../Client';
import Module from '../Module';
import { redirected, unsuffixed } from '../storageRedirect';
import ProxyModule from './Proxy';

export default class IndexedDBModule extends Module<Client> {
	apply() {
		const client = this.client;
		const global = client.global;
		const proxyModule = client.getModule(ProxyModule)!;

		global.IDBFactory.prototype.open = proxyModule.wrapFunction(
			global.IDBFactory.prototype.open,
			(target, that, args) => {
				const [factory, key] = redirected(that, client.storageKey);
				if (typeof args[0] === 'string') args[0] = `${args[0]}@${key}`;
				return Reflect.apply(target, factory, args);
			},
		);

		// deleting a database is deleting the page's own
		global.IDBFactory.prototype.deleteDatabase = proxyModule.wrapFunction(
			global.IDBFactory.prototype.deleteDatabase,
			(target, that, args) => {
				const [factory, key] = redirected(that, client.storageKey);
				if (typeof args[0] === 'string') args[0] = `${args[0]}@${key}`;
				return Reflect.apply(target, factory, args);
			},
		);

		// the page's own databases, by their own names
		const factory = global.IDBFactory.prototype as IDBFactory & {
			databases?: () => Promise<IDBDatabaseInfo[]>;
		};
		if (typeof factory.databases === 'function')
			factory.databases = proxyModule.wrapFunction(
				factory.databases,
				async (target, that, args) => {
					const [own, key] = redirected(that, client.storageKey);
					const suffix = `@${key}`;
					const list = (await Reflect.apply(
						target,
						own,
						args,
					)) as IDBDatabaseInfo[];
					return list
						.filter((info) => info.name?.endsWith(suffix))
						.map((info) => ({
							...info,
							name: info.name!.slice(0, -suffix.length),
						}));
				},
			);

		Reflect.defineProperty(global.IDBDatabase.prototype, 'name', {
			get: proxyModule.wrapFunction(
				Reflect.getOwnPropertyDescriptor(global.IDBDatabase.prototype, 'name')!
					.get!,
				(target, that, args) => {
					// `name@origin`: strip the suffix, not the prefix
					return unsuffixed(
						Reflect.apply(target, that, args) as string,
						client.storageKey,
						client.url.url.origin,
					);
				},
			),
		});
	}
}
