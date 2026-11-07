// What a page learns from its child frames: the child's view of its ancestry,
// what the parent reads back through contentWindow / contentDocument, the
// frames collection, about:blank and srcdoc children, a grandchild posting to
// top, and a cross-site child a real browser would keep opaque
// (test/pages/adv-frames.html with adv-child.html).
import { runGroup } from '../adversarial.mjs';

await runGroup('frames', {
	'same-origin child read from parent': 'frames-contentdocument-urls',
	'child-same-origin': 'frames-collection-and-relationships',
	'frames collection': 'frames-collection-and-relationships',
	'grandchild direct': 'frames-nested',
	'grandchild top.postMessage': 'frames-nested',
	'about:blank child': 'eval-iframe-realm',
	'about:blank document.write script': 'frames-document-write',
	'about:blank written script': 'frames-document-write',
	'srcdoc child read from parent': 'frames-srcdoc',
	'srcdoc child script': 'frames-srcdoc',
	'cross-site child read from parent':
		'originisolation-cross-site-frame-access',
	'cross-site child': 'originisolation-cross-site-frame-access',
	'storage event from child': 'storage-event-child-frame',
	'window.open(child, _blank)': 'navigation-popup-opener-postmessage',
	'iframe sandbox round trip': 'frames-sandbox-attribute',
});
