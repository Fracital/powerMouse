// What a tainted source's refusals say (modules/CanvasTaint.ts, which says
// why): a deferred part of the document bundle (./deferredParts.ts), made
// at a document's first such refusal. Its top level reads no global.
import type { Kind } from './modules/CanvasTaint';

/** the source a WebGL texture call names, by its kind */
const SOURCE_NAME: Record<Kind, string> = {
	image: 'The image element',
	svgImage: 'The image element',
	video: 'The video element',
	canvas: 'The canvas element',
	other: 'The source image',
};

/** WebGL's refusal of a tainting source as a texture (`method` of `name`) */
export const textureRefusal = (method: string, name: string, kind: Kind) =>
	`Failed to execute '${method}' on '${name}': ${SOURCE_NAME[kind]} contains cross-origin data, and may not be loaded.`;

/** a VideoFrame's refusal of a tainting source */
export const videoFrameRefusal = () =>
	"Failed to construct 'VideoFrame': VideoFrames can't be created from tainted sources.";

/**
 * A tainted OffscreenCanvas's convertToBlob() refusal. Chrome 153 reworded
 * its OffscreenCanvas errors: 'Tainted "OffscreenCanvas" may not be
 * exported.' became 'A tainted OffscreenCanvas may not be exported.'. No
 * canvas is tainted natively in proxy space, so the wording is told by a
 * sibling message of the same change: the no-context rejection quotes
 * "OffscreenCanvas" only in the old one (the browser's `convertToBlob` of
 * an empty canvas of `global`'s).
 */
export const exportRefusal = (
	global: typeof globalThis,
	convertToBlob: Function,
): Promise<string> =>
	(
		Reflect.apply(convertToBlob, new global.OffscreenCanvas(1, 1), []).then(
			() => '',
			(error: unknown) => String((error as Error)?.message),
		) as Promise<string>
	).then(
		(probe) =>
			`Failed to execute 'convertToBlob' on 'OffscreenCanvas': ${
				probe.includes('"OffscreenCanvas"')
					? 'Tainted "OffscreenCanvas" may not be exported.'
					: 'A tainted OffscreenCanvas may not be exported.'
			}`,
	);
