/**
 * The SVG element interfaces whose prototype has its own `href` (an
 * SVGAnimatedString): the SVGURIReference mixin's, and SVGScriptElement's.
 * The DOMAttributes module hooks these by name instead of reading every
 * `SVG...Element` global, since reading a global makes its interface in the
 * frame, and the other sixty cost every proxied frame about 35 KB of heap.
 * Measured in Chrome 152 and 156; the style-readback suite checks the list
 * against the browser it runs, so an interface Chrome adds is noticed.
 */
export const SVG_HREF_INTERFACES = [
	'SVGAElement',
	'SVGFEImageElement',
	'SVGFilterElement',
	'SVGGradientElement',
	'SVGImageElement',
	'SVGMPathElement',
	'SVGPatternElement',
	'SVGScriptElement',
	'SVGTextPathElement',
	'SVGUseElement',
];
