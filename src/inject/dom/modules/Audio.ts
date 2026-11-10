import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient from '../Client';

export default class AudioModule extends Module<DocumentClient> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const prototype = this.client.global.HTMLAudioElement.prototype;
		const elementConstructor = Reflect.getOwnPropertyDescriptor(
			prototype,
			'constructor',
		)!;

		this.client.global.Audio = proxyModule.wrapFunction(
			this.client.global.Audio,
			(target, that, args, newTarget) => {
				// the source goes through the element's src property as the page
				// would set it, so it is routed and reads back as written: routed
				// here it was the element's real attribute, and a blob: URL the
				// page made read back in the proxy's form
				const audio = Reflect.construct(target, [], newTarget);
				if (args.length && args[0] !== undefined)
					Reflect.apply(
						Reflect.getOwnPropertyDescriptor(
							this.client.global.HTMLMediaElement.prototype,
							'src',
						)!.set!,
						audio,
						[String(args[0])],
					);
				return audio;
			},
			true,
		);
		// Audio is a named constructor: its prototype is HTMLAudioElement's,
		// whose constructor stays HTMLAudioElement
		Reflect.defineProperty(prototype, 'constructor', elementConstructor);
	}
}
