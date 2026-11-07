// Every route by which text becomes running script: script text setters and
// text-node mutations, data:/blob: script src, inline handler attributes set
// through every attribute API, markup parsed into shadow roots or foreign
// documents then adopted, XSLT output, SVG script, srcdoc frames and
// javascript: URLs (test/pages/adv-scripts.html).
import { runGroup } from '../adversarial.mjs';

await runGroup('scripts', {
	'script.text': 'escapes-script-text',
	'script.innerText': 'escapes-script-innertext',
	'script.append(string)': 'escapes-script-append-string',
	'script.appendChild(textNode)': 'escapes-script-appendchild-textnode',
	'script.prepend(string)': 'escapes-script-prepend-string',
	'script.replaceChildren(string)': 'escapes-script-replacechildren-string',
	'script.insertAdjacentText': 'escapes-script-insertadjacenttext',
	'textNode.data': 'escapes-script-textnode-data',
	'textNode.nodeValue': 'escapes-script-textnode-nodevalue',
	'textNode.textContent': 'escapes-script-textnode-textcontent',
	'textNode.appendData': 'escapes-script-textnode-appenddata',
	'textNode.insertData': 'escapes-script-textnode-insertdata',
	'textNode.replaceData': 'escapes-script-textnode-replacedata',
	'script.setAttributeNode(src, data:)':
		'escapes-setattributenode-script-src-data',
	'script.attributes.setNamedItem(src, data:)':
		'escapes-setnameditem-script-src-data',
	'setAttribute onclick': 'escapes-setattribute-onclick',
	'setAttributeNS onclick': 'escapes-setattributens-onclick',
	'setAttributeNode onclick': 'escapes-setattributenode-onclick',
	'attributes.setNamedItem onclick': 'escapes-setnameditem-onclick',
	'shadowRoot.innerHTML img onerror': 'escapes-shadowroot-innerhtml-onerror',
	'shadowRoot.setHTMLUnsafe img onerror':
		'escapes-shadowroot-sethtmlunsafe-onerror',
	'Document.parseHTMLUnsafe img onerror adopted':
		'escapes-document-parsehtmlunsafe-static-img-onerror',
	'DOMParser xhtml img onerror adopted': 'escapes-domparser-xhtml-img-onerror',
	'XSLT transformToFragment img onerror':
		'escapes-xslt-transformtofragment-img-onerror',
	'XSLT transformToDocument img onerror':
		'escapes-xslt-transformtodocument-img-onerror',
	'svg script textContent': 'escapes-svg-script-textcontent',
	'svg script xlink:href data:': 'escapes-svg-script-setattributens-href-data',
	'iframe.setAttributeNode(srcdoc)': 'escapes-setattributenode-iframe-srcdoc',
	'iframe.attributes.setNamedItem(srcdoc)':
		'escapes-setnameditem-iframe-srcdoc',
	'Reflect.set(window, location, javascript:)':
		'escapes-reflect-set-location-javascript',
	'Reflect.set(document, location, javascript:)':
		'escapes-reflect-set-document-location-javascript',
	'Object.assign(window, {location})':
		'escapes-object-assign-window-location-javascript',
	'about:blank contentWindow.eval': 'eval-iframe-realm',
	'document.write script': 'documentwrite',
	'about:blank document.write': 'frames-document-write',
	'iframe.srcdoc': 'frames-srcdoc',
});
