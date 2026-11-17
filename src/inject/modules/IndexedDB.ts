import Client from '../Client';
import Module from '../Module';
import ProxyModule from './Proxy';

export default class IndexedDBModule extends Module<Client> {
	apply() {
		const client = this.client;
		const global = client.global;
		const proxyModule = client.getModule(ProxyModule)!;

		global.IDBFactory.prototype.open = proxyModule.wrapFunction(
			global.IDBFactory.prototype.open,
			(target, that, args) => {
				if (typeof args[0] === 'string') {
					args[0] = `${args[0]}@${client.storageKey}`;
				}

				return Reflect.apply(target, that, args);
			},
		);

		// deleting a database is deleting the page's own
		global.IDBFactory.prototype.deleteDatabase = proxyModule.wrapFunction(
			global.IDBFactory.prototype.deleteDatabase,
			(target, that, args) => {
				if (typeof args[0] === 'string')
					args[0] = `${args[0]}@${client.storageKey}`;
				return Reflect.apply(target, that, args);
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
					const suffix = `@${client.storageKey}`;
					const list = (await Reflect.apply(
						target,
						that,
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
					const name = Reflect.apply(target, that, args) as string;
					const suffix = `@${client.storageKey}`;
					return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
				},
			),
		});
	}
}
