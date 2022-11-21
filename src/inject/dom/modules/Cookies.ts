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
	get pageCookies() {
		const syncModule = this.client.getModule(SyncModule)!;

		return new BrowserCookieArray(
			...syncModule.jsonAPI(
				`${this.client.directory}cookies/get`,
				this.client.url.toString()
			)
		).toString();
	}
	set pageCookies(value: string) {
		const syncModule = this.client.getModule(SyncModule)!;

		syncModule.jsonAPI(
			`${this.client.directory}cookies/set`,
			value,
			this.client.url.toString()
		);
	}
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;

		Reflect.defineProperty(this.client.global.Document.prototype, 'cookie', {
			configurable: true,
			enumerable: true,
			get: proxyModule.wrapFunction(
				this.cookieDescriptor.get!,
				(target, that) => {
					invokeGlobal(that, document);
					return this.pageCookies;
				}
			),
			set: proxyModule.wrapFunction(
				this.cookieDescriptor.set!,
				(target, that, args) => {
					invokeGlobal(that, document);
					this.pageCookies = String(args[0]);
				}
			),
		});
	}
}
