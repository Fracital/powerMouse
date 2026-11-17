// The browser's own accessors and methods that a long task's and a long
// animation frame's handlers (./modules/LongTasks.ts, ./modules/LongFrames.ts)
// read entries and frames with, taken when the bundle runs, before any page
// script: those handlers are deferred parts (./deferredParts.ts), evaluated
// when a document's first such entry reaches its page.
export const nativeEntryName =
	typeof PerformanceEntry === 'function'
		? Reflect.getOwnPropertyDescriptor(PerformanceEntry.prototype, 'name')
		: undefined;
export const nativeFrameElement =
	typeof Window === 'function'
		? Reflect.getOwnPropertyDescriptor(globalThis, 'frameElement')?.get
		: undefined;
export const nativeContentWindow =
	typeof HTMLIFrameElement === 'function'
		? Reflect.getOwnPropertyDescriptor(
				HTMLIFrameElement.prototype,
				'contentWindow',
			)?.get
		: undefined;
export const nativeQuery =
	typeof Document === 'function'
		? Document.prototype.querySelectorAll
		: undefined;
export const nativeGetAttribute =
	typeof Element === 'function' ? Element.prototype.getAttribute : undefined;
