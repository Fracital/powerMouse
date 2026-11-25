// Build-time stand-in for ./codecInstance.ts in the document bundles
// (build.js stubCodecInstance), as ../sivCodecStub.ts is for the siv codec:
// a document's instance is made by the deferred part (./codecBytes.ts), and
// only where its realm holds the parts already (../inject/dom/document.ts
// sets `made`). Without one it throws, and the JavaScript seals
// (./codec.ts ownCodec).
import type { codecInstance as made } from './codecInstance';

/** the part that makes the document bundle's instance (../inject/dom/document.ts) */
export const codecInstanceParts: { made?: () => typeof made | undefined } = {};

export const codecInstance: typeof made = (
	text,
	build,
	WasmModule,
	WasmInstance,
	exportsOf,
	bufferOf,
	Bytes,
) =>
	codecInstanceParts.made!()!(
		text,
		build,
		WasmModule,
		WasmInstance,
		exportsOf,
		bufferOf,
		Bytes,
	);
