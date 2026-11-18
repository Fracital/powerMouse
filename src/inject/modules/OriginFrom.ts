import Client from '../Client';
import Module from '../Module';
import type { OriginClass, originFrom } from '../originFrom';
import { originFromParts } from '../originFromParts';
import ProxyModule from './Proxy';

/**
 * `Origin.from()` reads a platform object's origin from its internal slots,
 * which under the proxy hold the proxy's origin for every site: the page's
 * own global, a window, a link's URL and a window message's sender all
 * extracted as the proxy origin, so two sites compared same-origin and a
 * window of another site gave an origin where Chrome throws. Each answers
 * with its emulated origin here; what the browser refuses (a synthetic
 * event, a Location, a window of another real origin) it still refuses,
 * in its own words, and strings and URL objects are the page's own.
 */
export default class OriginFromModule extends Module<Client> {
	apply() {
		const client = this.client;
		const global = client.global as unknown as { Origin?: OriginClass };
		const Origin = global.Origin;
		if (typeof Origin?.from !== 'function') return;
		const proxyModule = client.getModule(ProxyModule)!;
		const nativeFrom = Origin.from;
		// what each value answers (../originFrom.ts), made at a realm's first
		// call: before the browser's
		let answer: ReturnType<typeof originFrom> | undefined;
		Origin.from = proxyModule.wrapFunction(nativeFrom, (target, that, args) =>
			(answer ??= originFromParts.answer!()(client, nativeFrom, Origin))(
				target,
				that,
				args,
			),
		);
	}
}
