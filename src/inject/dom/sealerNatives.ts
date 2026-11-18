// What a sealed copy (./sealedCopies.ts, a deferred part) makes its URLs
// with, taken when the bundle loads, before the page runs: null where the
// realm has no workers.

type Post = (message: unknown) => void;

export const sealerNatives = (() => {
	try {
		const Worker = globalThis.Worker;
		return {
			Worker,
			createObjectURL: globalThis.URL.createObjectURL,
			URL: globalThis.URL,
			Blob: globalThis.Blob,
			post: Worker.prototype.postMessage as Post,
			terminate: Worker.prototype.terminate,
			listen: globalThis.EventTarget.prototype.addEventListener,
			dataOf: Reflect.getOwnPropertyDescriptor(
				globalThis.MessageEvent.prototype,
				'data',
			)!.get!,
			setTimeout: globalThis.setTimeout.bind(globalThis),
			now: Date.now,
		};
	} catch (error) {
		return null;
	}
})();

/** the natives a sealed copy is made with (null: none could be taken) */
export type SealerNatives = typeof sealerNatives;
