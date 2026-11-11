/**
 * The interfaces whose prototype has a CSS member the inject hooks, by name:
 * reading every `CSS...Rule` global made all 25 interfaces in each frame,
 * about 5 KB of heap. Measured in Chrome 152 and 156; the style-readback
 * suite checks the lists against the browser it runs, so a member Chrome
 * adds to another interface is noticed.
 */
/** with their own insertRule, appendRule or deleteRule (the CSSOM module) */
export const RULE_METHOD_INTERFACES = [
	'CSSGroupingRule',
	'CSSKeyframesRule',
	'CSSStyleRule',
];
/**
 * with their own `style` getter, a declaration block (the CSSReadback
 * module): the rules', the declarations that follow a nested rule
 * (CSSNestedDeclarations) and an @function's (CSSFunctionDeclarations). A
 * block the page gets unwrapped takes a URL by a named property past the
 * proxy (`nested.style.backgroundImage = 'url(...)'` loaded from the site)
 */
export const RULE_STYLE_INTERFACES = [
	'CSSFontFaceRule',
	'CSSFunctionDeclarations',
	'CSSKeyframeRule',
	'CSSMarginRule',
	'CSSNestedDeclarations',
	'CSSPageRule',
	'CSSPositionTryRule',
	'CSSStyleRule',
];
/**
 * the element interfaces with their own `style` getter, an element's inline
 * declarations (the DOMAttributes module): a MathML element's was left
 * unwrapped and took a URL the same way. FontFace's `style` is a string and
 * no declaration
 */
export const ELEMENT_STYLE_INTERFACES = [
	'HTMLElement',
	'MathMLElement',
	'SVGElement',
];
