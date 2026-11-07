// Every direct spelling of top / parent / location / frameElement and the
// document URL surface, read inside the proxied page (test/pages/adv-globals.html).
import { runGroup } from '../adversarial.mjs';

await runGroup('globals', {
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
});
