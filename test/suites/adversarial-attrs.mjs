// Every way a URL-bearing attribute or style reads back: attribute getters,
// Attr nodes, NamedNodeMap, serializers, prototype getters on the live
// element, selectors, MutationObserver records, the CSSOM and computed style
// (test/pages/adv-attrs.html).
import { runGroup } from '../adversarial.mjs';

await runGroup('attrs', {
	'a.getAttributeNames()': 'domattr-names-and-serialization',
	'a.outerHTML': 'domattr-names-and-serialization',
	'a.cloneNode().outerHTML': 'domattr-clonenode',
	'[...a.attributes] values': 'domattr-attributes-namednodemap',
	'a.attributes[0].value': 'domattr-attributes-namednodemap',
	'MutationObserver records': 'domattr-mutationobserver-records',
	'a.matches(\'[href="/x?q=1#h"]\')': 'domattr-selector-literal-value',
	'integrity attribute': 'domattr-integrity-property',
	'shadowRoot innerHTML round trip': 'domattr-shadow-innerhtml-urls',
	'img.src': 'elurls-img-src',
	'img.currentSrc': 'elurls-img-currentsrc',
	'img.srcset': 'elurls-srcset',
	'a.origin': 'elurls-anchor-components',
	'a.toString()': 'elurls-anchor-stringifier',
	"a + ''": 'elurls-anchor-stringifier',
	'a.href component setters': 'elurls-anchor-component-setters',
	'video.poster': 'elurls-unproxied-properties',
	'use.href.baseVal': 'elurls-svg-use-baseval',
	'base href resolution': 'elurls-base-href-resolution',
	'XMLSerializer a': 'serialization-xmlserializer-live',
	'XMLSerializer svg image': 'serialization-xmlserializer-parsed-and-svg',
	'DOMParser innerHTML round trip': 'serialization-domparser',
	'template innerHTML round trip': 'serialization-template',
	'createContextualFragment round trip':
		'serialization-range-createcontextualfragment',
	'document.styleSheets hrefs': 'stylesheets-document-stylesheets-href',
	'@import rule href': 'stylesheets-document-stylesheets-href',
	'constructable stylesheet readback': 'stylesheets-constructable-url-readback',
	'getComputedStyle(#bg2).backgroundImage': 'cssurls-computed-style',
	'inline style sheet rule backgroundImage': 'cssurls-cssrule-style-property',
	'inline style sheet rule cssText': 'cssurls-stylesheet-csstext',
	'el.style.backgroundImage round trip': 'cssurls-cssom-write-serialization',
	'el.style.cssText write': 'cssurls-cssom-write-serialization',
	'style attribute set then readback': 'cssurls-setattribute-roundtrip',
	'setProperty background-image': 'cssurls-author-string-preserved',
	'typed OM background-image':
		'longtail-api-typed-om-background-image-readback',
	'document.scripts srcs': 'location-resource-urls',
});
