import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import type DocumentClient from '../Client';

/**
 * Chrome stops updating the rendering of a frame that is cross-origin to the
 * main frame while it is not rendered (a `display:none` frame, or one inside
 * such a frame): its animation frame callbacks wait until it is shown. A
 * same-origin frame keeps running them, and it is not laid out either, so
 * every element in it measures 0. Through the proxy every frame is
 * same-origin with the page, so a hidden frame of another site ran callbacks
 * it never runs natively and measured nothing: Google Sign-In's button frame,
 * which LinkedIn keeps in a hidden layout, measured its button after a double
 * requestAnimationFrame, read 0, and its retry (`setTimeout(this.u, 50)`, an
 * unbound method) threw "Cannot read properties of undefined (reading
 * 'Db')". In a document of another origin than the proxied top, a callback
 * that comes due while its frame is not rendered waits for the frame to be
 * shown. Measured in Chrome 152: a same-site frame of another origin is held
 * too, `visibility: hidden` holds nothing.
 */
export default class AnimationFramesModule extends Module<DocumentClient> {
	apply() {
		const global = this.client.global;
		if (typeof global.requestAnimationFrame !== 'function') return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const getClientRects = global.Element.prototype.getClientRects;

		// a frame of the page's that is cross-origin to the proxied top
		const throttled = () => {
			if (!this.client.nested) return false;
			try {
				return (
					this.client.sandboxedOpaque ||
					this.client.url.url.origin !== this.client.topOrigin
				);
			} catch (error) {
				return false;
			}
		};
		// whether this frame, or a frame it is in below the proxied top, has
		// no box (the host's frame, around the proxied top, is not the page's)
		const hidden = () => {
			let client: DocumentClient = this.client;
			for (let depth = 0; depth < 64 && client.nested; depth++) {
				const frame = client.nativeFrameElement();
				if (!frame) return false;
				if (Reflect.apply(getClientRects, frame, []).length === 0) return true;
				try {
					client = (client.parent as Record<string, any>)[
						this.client.names.client
					] as DocumentClient;
				} catch (error) {
					return false;
				}
			}
			return false;
		};

		// a held callback's id (the native id it was first given, which the
		// page holds) -> the native id it waits on now
		const held = new Map<number, number>();
		global.requestAnimationFrame = proxyModule.wrapFunction(
			global.requestAnimationFrame,
			(target, that, args) => {
				const callback = args[0];
				if (typeof callback !== 'function' || !throttled())
					return Reflect.apply(target, that, args);
				let id = 0;
				const run = (time: number) => {
					if (hidden()) {
						held.set(id, Reflect.apply(target, global, [run]));
						return;
					}
					held.delete(id);
					Reflect.apply(callback, undefined, [time]);
				};
				id = Reflect.apply(target, that, [run]) as number;
				held.set(id, id);
				return id;
			},
		);
		global.cancelAnimationFrame = proxyModule.wrapFunction(
			global.cancelAnimationFrame,
			(target, that, args) => {
				const waiting =
					typeof args[0] === 'number' ? held.get(args[0]) : undefined;
				if (waiting === undefined) return Reflect.apply(target, that, args);
				held.delete(args[0]);
				return Reflect.apply(target, that, [waiting]);
			},
		);
	}
}
