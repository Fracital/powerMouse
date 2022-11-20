import { BrowserCookieArray } from '../../../server/Cookies';
import Module from '../../Module';
import ProxyModule, { invokeGlobal } from '../../modules/Proxy';
import DocumentClient from '../Client';
import SyncModule from './Sync';

export class CookiesModule extends Module<DocumentClient> {
	private cookieDescriptor: PropertyDescriptor;
	constructor(client: DocumentClient) {
		super(client);

		this.cookieDescriptor = Reflect.getOwnPropertyDescriptor(
			this.client.global.Document.prototype,
			'cookie'
		)!;
	}
	get cookie() {
		return this.cookieDescriptor.get!.call(this.client.global.document);
	}
	set cookie(value: string) {
		this.cookieDescriptor.set!.call(this.client.global.document, value);
	}
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const syncModule = this.client.getModule(SyncModule)!;

		Reflect.defineProperty(this.client.global.Document.prototype, 'cookie', {
			configurable: true,
			enumerable: true,
			get: proxyModule.wrapFunction(
				this.cookieDescriptor.get!,
				(target, that) => {
					invokeGlobal(that, document);
					return new BrowserCookieArray(
						...syncModule.jsonAPI(
							`${this.client.directory}cookies/get`,
							this.client.url.toString()
						)
					).toString();
				}
			),
			set: proxyModule.wrapFunction(
				this.cookieDescriptor.set!,
				(target, that, args) => {
					invokeGlobal(that, document);
					const value = String(args[0]);

					syncModule.jsonAPI(
						`${this.client.directory}cookies/set`,
						value,
						this.client.url.toString()
					);
				}
			),
		});
	}
}
