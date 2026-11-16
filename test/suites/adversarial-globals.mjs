// Every direct spelling of top / parent / location / frameElement and the
// document URL surface, read inside the proxied page (test/pages/adv-globals.html).
import { runGroup } from '../adversarial.mjs';

// The checks of this group that fail on purpose, each with its reason
// (test/adversarial.mjs, `knownOpen`): none on Chrome 156 or 157 (2026-11-16).
// A new failure is a regression to fix, or an entry here that says why not.
const KNOWN_OPEN = {};

await runGroup(
	'globals',
	{
		'location.ancestorOrigins': 'location-ancestororigins',
		'location.href': 'location-components',
		"location + ''": 'location-stringify',
		'JSON.stringify(location)': 'location-descriptors',
		'document.URL': 'location-document-urls',
		'document.baseURI': 'location-document-urls',
		'window.origin': 'location-document-urls',
		'document.scripts srcs': 'location-resource-urls',
		'window.name': 'windoc-window-name',
		'destructure {top: t}': 'shadowing-params',
	},
	{ knownOpen: KNOWN_OPEN },
);
