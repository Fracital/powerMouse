/**
 * The CSS rule interfaces whose prototype has a member the inject hooks, by
 * name: reading every `CSS...Rule` global made all 25 interfaces in each
 * frame, about 5 KB of heap. Measured in Chrome 152 and 156; the
 * style-readback suite checks both lists against the browser it runs, so a
 * member Chrome adds to another rule is noticed.
 */
/** with their own insertRule, appendRule or deleteRule (the CSSOM module) */
export const RULE_METHOD_INTERFACES = [
	'CSSGroupingRule',
	'CSSKeyframesRule',
	'CSSStyleRule',
];
/** with their own `style` getter (the CSSReadback module) */
export const RULE_STYLE_INTERFACES = [
	'CSSFontFaceRule',
	'CSSKeyframeRule',
	'CSSMarginRule',
	'CSSPageRule',
	'CSSPositionTryRule',
	'CSSStyleRule',
];
