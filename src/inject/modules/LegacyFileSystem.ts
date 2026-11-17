import Client from '../Client';
import { legacyFileSystemParts } from '../legacyFileSystemParts';
import Module from '../Module';
import ProxyModule from './Proxy';

const ENTRY_POINTS = [
	'webkitRequestFileSystem',
	'webkitResolveLocalFileSystemURL',
	'webkitRequestFileSystemSync',
	'webkitResolveLocalFileSystemSyncURL',
];

/**
 * The legacy sandboxed file system is the browser's per real origin, which
 * every proxied site shares: each site gets one of its own
 * (../legacyFileSystem.ts), set up with the realm's first call.
 */
export default class LegacyFileSystemModule extends Module<Client> {
	apply() {
		const client = this.client;
		const proxyModule = client.getModule(ProxyModule)!;
		const global = client.global as unknown as Record<string, unknown>;
		const resolve = global.webkitResolveLocalFileSystemURL as
			((...args: unknown[]) => unknown) | undefined;
		let hooks: ReturnType<
			ReturnType<NonNullable<typeof legacyFileSystemParts.partition>>
		>;
		for (const name of ENTRY_POINTS) {
			const entry = global[name];
			if (typeof entry !== 'function') continue;
			global[name] = proxyModule.wrapFunction(
				entry as (...args: unknown[]) => unknown,
				(target, that, args) =>
					(hooks ??= legacyFileSystemParts.partition!()(
						client,
						proxyModule,
						typeof resolve === 'function' ? resolve : undefined,
					))[name](target, that, args),
			);
		}
	}
}
