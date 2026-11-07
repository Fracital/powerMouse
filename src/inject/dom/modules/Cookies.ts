import {
	BrowserCookieArray,
	type FloatingCookie,
} from '../../../server/Cookies';
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
			'cookie',
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

		const cookies: FloatingCookie[] = syncModule.jsonAPI(
			`${this.client.directory}cookies/get`,
			this.client.url.toString(),
		);

		// HttpOnly cookies still reach the server but never page script
		return new BrowserCookieArray(
			...cookies.filter((cookie) => !cookie.httpOnly),
		).toString();
	}
	set pageCookies(value: string) {
		const syncModule = this.client.getModule(SyncModule)!;

		// a script-set cookie can neither create nor replace an HttpOnly one
		syncModule.jsonAPI(
			`${this.client.directory}cookies/set`,
			value,
			this.client.url.toString(),
			'script',
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
				},
			),
			set: proxyModule.wrapFunction(
				this.cookieDescriptor.set!,
				(target, that, args) => {
					invokeGlobal(that, document);
					this.pageCookies = String(args[0]);
				},
			),
		});
	}
}
