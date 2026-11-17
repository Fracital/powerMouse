// Every route by which text becomes running script: script text setters and
// text-node mutations, data:/blob: script src, inline handler attributes set
// through every attribute API, markup parsed into shadow roots or foreign
// documents then adopted, XSLT output, SVG script, srcdoc frames and
// javascript: URLs (test/pages/adv-scripts.html).
import { runGroup } from '../adversarial.mjs';

// The checks of this group that fail on purpose, each with its reason
// (test/adversarial.mjs, `knownOpen`): none on Chrome 157 (2026-11-17).
// A new failure is a regression to fix, or an entry here that says why not.
const KNOWN_OPEN = {};

// A hostile frame (adv-hostile-child.html) replaces builtins the browser
// never asks when it parses markup and runs its scripts: natively as many of
// its scripts run as in the frame that replaced nothing. One that ran fewer
// broke the inject (a replaced Array iterator once made appendHTMLUnsafe
// throw `Illegal invocation` and none of the frame's own scripts ran). The
// frames whose options answer otherwise each time (`flip`, `proxy`) are not
// compared: what the browser makes of those is not the plain frame's.
const ran = (probes, spoil) =>
	Object.entries(probes).filter(
		([name, result]) =>
			name.startsWith(`hostile ${spoil}: `) &&
			!name.endsWith(' [frame]') &&
			typeof result.value === 'object' &&
			result.value !== null,
	).length;
const compareHostile = (probes, check) => {
	const spoils = new Set(
		Object.keys(probes)
			.filter(
				(name) => name.startsWith('hostile ') && name.endsWith(' [frame]'),
			)
			.map((name) => name.slice('hostile '.length, -' [frame]'.length)),
	);
	const plain = ran(probes, 'none');
	for (const spoil of spoils) {
		if (spoil === 'none' || spoil === 'flip' || spoil === 'proxy') continue;
		const count = ran(probes, spoil);
		check(
			`hostile ${spoil}: as many scripts run as where nothing was replaced`,
			plain > 0 && count === plain,
			`${count} ran, ${plain} where nothing was replaced`,
		);
	}
};

await runGroup(
	'scripts',
	{
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
		'DOMParser xhtml img onerror adopted':
			'escapes-domparser-xhtml-img-onerror',
		'XSLT transformToFragment img onerror':
			'escapes-xslt-transformtofragment-img-onerror',
		'XSLT transformToDocument img onerror':
			'escapes-xslt-transformtodocument-img-onerror',
		'svg script textContent': 'escapes-svg-script-textcontent',
		'svg script xlink:href data:':
			'escapes-svg-script-setattributens-href-data',
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
	},
	{ knownOpen: KNOWN_OPEN, compare: compareHostile },
);
