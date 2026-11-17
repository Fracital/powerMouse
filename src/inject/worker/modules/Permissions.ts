import { routeBinary } from '../../../routeURL';
import StompURL from '../../../StompURL';
import {
	PERMISSION_ROUTE,
	type PermissionOp,
	type PermissionState,
	type PermissionStates,
} from '../../../transport/messages';
import { hookDevices } from '../../deviceGrants';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { withStack } from '../../nativeErrors';
import { notificationParts, type GateContext } from '../../permissionGates';
import WorkerClient from '../Client';

// taken when the bundle loads: a device's getters are checked by their source
const nativeToString = Function.prototype.toString;

/**
 * A worker's view of its site's permissions (docs/permissions.md): the
 * worker has no navigator.serviceWorker to post to, so it asks the service
 * worker's route (messages.ts PERMISSION_ROUTE), as the site its route
 * names it by. Notification.permission reads the site's state as a worker
 * reads it natively (`granted`, else `denied`; `denied` until the answer
 * is in), a notification is shown only as the site may (the document's
 * notificationParts), and navigator.usb, .hid and .serial list the site's
 * own devices (src/inject/deviceGrants.ts).
 */
export default class WorkerPermissionsModule extends Module<WorkerClient> {
	apply() {
		const client = this.client;
		const global = client.global;
		const proxyModule = client.getModule(ProxyModule)!;
		// the worker's top-level site: its route names it when it is another
		// site's, and it is its own origin's otherwise
		let site = '';
		try {
			site = client.partition.startsWith('^')
				? new URL(client.partition.slice(1)).origin
				: client.url.url.origin;
		} catch (error) {
			return;
		}
		const ask = async (op: PermissionOp): Promise<unknown> => {
			try {
				const response = await client.nativeFetch(
					`${global.location.origin}${client.directory}${PERMISSION_ROUTE}`,
					{
						method: 'POST',
						body: JSON.stringify({ ...op, site }),
						cache: 'no-store',
					},
				);
				return response.ok ? await response.json() : null;
			} catch (error) {
				return null;
			}
		};
		let states: Record<string, PermissionState> = {};
		void ask({ op: 'states' }).then((answer) => {
			if (answer) states = (answer as PermissionStates).states ?? {};
		});
		const siteState = (name: string): PermissionState =>
			states[name] ?? 'prompt';

		const Native = (global as { Notification?: Function }).Notification;
		if (typeof Native === 'function') {
			const permission = Reflect.getOwnPropertyDescriptor(Native, 'permission');
			if (permission?.get)
				Reflect.defineProperty(Native, 'permission', {
					...permission,
					get: proxyModule.wrapFunction(permission.get, () =>
						siteState('notifications') === 'granted' ? 'granted' : 'denied',
					),
				});
			const ctx: GateContext = {
				global,
				wrap: (fn, wrap, construct) =>
					proxyModule.wrapFunction(fn, wrap, construct),
				allowed: () => true,
				browserRefuses: () => false,
				siteState,
				request: async () => ({ call: false, dismissed: false }),
				direct: async () => false,
				error: (message, name) =>
					withStack(new global.DOMException(message, name)),
				base: () => client.baseURL.toString(),
				route: (url) => routeBinary(new StompURL(url, client.url)),
				site,
				onOpen: () => {},
				browserNotifications: () => {
					try {
						return Reflect.apply(permission!.get!, Native, []) as string;
					} catch (error) {
						return 'default';
					}
				},
			};
			let construct:
				| ((target: Function, args: unknown[], newTarget: Function) => object)
				| null = null;
			(global as { Notification?: Function }).Notification =
				proxyModule.wrapFunction(
					Native,
					(target, that, args, newTarget) => {
						construct ??= notificationParts(ctx, target);
						return construct(target, args, newTarget);
					},
					true,
				);
		}

		// navigator.usb, .hid and .serial, the first time the worker reads one
		const navigator = (global as { WorkerNavigator?: { prototype: object } })
			.WorkerNavigator?.prototype;
		if (!navigator) return;
		for (const kind of ['usb', 'hid', 'serial'] as const) {
			const descriptor = Reflect.getOwnPropertyDescriptor(navigator, kind);
			if (!descriptor?.get) continue;
			let done = false;
			Reflect.defineProperty(navigator, kind, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (target, that, args) => {
					const object = Reflect.apply(target, that, args);
					if (!done && object) {
						done = true;
						hookDevices(
							{
								global,
								wrap: (fn, wrap) => proxyModule.wrapFunction(fn, wrap),
								ask,
								nativeToString,
								salt: async () => null,
								error: (message, name) =>
									withStack(new global.DOMException(message, name)),
							},
							kind,
							object,
						);
					}
					return object;
				}),
			});
		}
	}
}
