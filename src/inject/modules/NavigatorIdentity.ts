import {
	userAgentIdentity,
	type UserAgentBrand,
	type UserAgentIdentity,
} from '../../userAgent';
import type Client from '../Client';
import Module from '../Module';
import ProxyModule from './Proxy';

const copyBrands = (brands: UserAgentBrand[]) =>
	brands.map(({ brand, version }) => ({ brand, version }));

/** Replace the values of a native dictionary without changing its key order. */
function identifyValues(
	values: unknown,
	identity: UserAgentIdentity,
	brands: UserAgentBrand[],
) {
	if (typeof values !== 'object' || values === null) return;
	const record = values as Record<string, unknown>;
	const replace = (key: string, value: unknown) => {
		if (Reflect.getOwnPropertyDescriptor(record, key))
			Reflect.set(record, key, value);
	};
	replace('brands', copyBrands(brands));
	replace('mobile', identity.mobile);
	replace('platform', identity.uaPlatform);
	replace('architecture', identity.architecture);
	replace('bitness', identity.bitness);
	replace('formFactors', [...identity.formFactors]);
	replace('fullVersionList', copyBrands(identity.fullVersionList));
	replace('model', identity.model);
	replace('platformVersion', identity.platformVersion);
	replace('uaFullVersion', identity.fullVersion);
	replace('wow64', identity.wow64);
}

/** The configured identity on Navigator or WorkerNavigator and NavigatorUAData. */
export default class NavigatorIdentityModule extends Module<Client> {
	apply() {
		const configured = this.client.configuredUserAgent;
		if (!configured) return;
		const identity = userAgentIdentity(configured);
		this.client.userAgentIdentity = identity;
		const global = this.client.global;
		const proxy = this.client.getModule(ProxyModule)!;
		const prototype = (global.Navigator ?? global.WorkerNavigator)
			?.prototype as Record<string, any> | undefined;
		if (!prototype) return;
		const getter = (
			name: 'userAgent' | 'appVersion' | 'platform',
			value: string,
		) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(prototype, name);
			if (!descriptor?.get) return;
			Reflect.defineProperty(prototype, name, {
				...descriptor,
				get: proxy.wrapFunction(descriptor.get, (target, that, args) => {
					// The native getter still checks the receiver.
					Reflect.apply(target, that, args);
					return value;
				}),
			});
		};
		getter('userAgent', identity.userAgent);
		getter('appVersion', identity.appVersion);
		getter('platform', identity.platform);

		const dataPrototype = (global as any).NavigatorUAData?.prototype as
			Record<string, any> | undefined;
		if (!dataPrototype) return;
		for (const [name, value] of [
			['mobile', identity.mobile],
			['platform', identity.uaPlatform],
		] as const) {
			const descriptor = Reflect.getOwnPropertyDescriptor(dataPrototype, name);
			if (!descriptor?.get) continue;
			Reflect.defineProperty(dataPrototype, name, {
				...descriptor,
				get: proxy.wrapFunction(descriptor.get, (target, that, args) => {
					Reflect.apply(target, that, args);
					return value;
				}),
			});
		}
		const brands = Reflect.getOwnPropertyDescriptor(dataPrototype, 'brands');
		if (brands?.get)
			Reflect.defineProperty(dataPrototype, 'brands', {
				...brands,
				get: proxy.wrapFunction(brands.get, (target, that, args) => {
					Reflect.apply(target, that, args);
					return copyBrands(identity.brands);
				}),
			});
		const high = Reflect.getOwnPropertyDescriptor(
			dataPrototype,
			'getHighEntropyValues',
		);
		if (typeof high?.value === 'function')
			Reflect.defineProperty(dataPrototype, 'getHighEntropyValues', {
				...high,
				value: proxy.wrapFunction(high.value, (target, that, args) => {
					// Native conversion, receiver checks and permissions-policy refusal
					// all happen before any configured value is returned. Keeping the
					// callback synchronous also keeps a native synchronous throw.
					const pending = Reflect.apply(target, that, args) as Promise<unknown>;
					return pending.then((values) => {
						identifyValues(values, identity, identity.brands);
						return values;
					});
				}),
			});
		const json = Reflect.getOwnPropertyDescriptor(dataPrototype, 'toJSON');
		if (typeof json?.value === 'function')
			Reflect.defineProperty(dataPrototype, 'toJSON', {
				...json,
				value: proxy.wrapFunction(json.value, (target, that, args) => {
					const values = Reflect.apply(target, that, args);
					identifyValues(values, identity, identity.brands);
					return values;
				}),
			});
	}
}
