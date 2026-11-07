// Runtime APIs that hand back a URL: timing entries, error stacks and
// ErrorEvent.filename, import.meta, the Navigation API, Request / Response /
// XHR / WebSocket / EventSource URLs, object URLs, the service worker
// registration, CacheStorage and IndexedDB names, storage keys and cookies
// (test/pages/adv-urls.html).
import { runGroup } from '../adversarial.mjs';

await runGroup('urls', {
	'navigation entry name': 'location-resource-urls',
	'navigation entry toJSON name':
		'longtail-api-performance-navigation-tojson-name',
	'resource entry names': 'platform-resource-timing-no-proxy-internals',
	'performance.getEntries names': 'platform-resource-timing-no-proxy-internals',
	'performance.mark name': 'longtail-api-performance-user-mark-masked-name',
	'PerformanceObserver buffered': 'platform-performance-observer',
	'inline Error().stack': 'platform-error-stack-urls',
	'inline caught stack': 'platform-error-stack-urls',
	'external script Error().stack': 'platform-error-stack-urls',
	'external script caught stack': 'platform-error-stack-urls',
	'new Function error stack': 'platform-error-stack-urls',
	'eval error stack': 'platform-error-stack-urls',
	'window.onerror filename': 'platform-error-stack-urls',
	'error event filename': 'workers-error-event',
	'fetched module import.meta': 'modules-import-meta-url',
	'document.currentScript.src': 'modules-script-injection',
	'navigation.currentEntry.url': 'windoc-navigation-api',
	'navigation.entries urls': 'windoc-navigation-api',
	'pushState then location/currentEntry':
		'windoc-navigation-api-follows-pushstate',
	'hashchange URLs': 'location-hashchange-event',
	'fetch Response.url': 'elurls-request-response',
	'xhr.responseURL': 'elurls-xhr-response-url',
	'WebSocket.url': 'elurls-websocket-url',
	'EventSource.url': 'http-eventsource-url',
	'URL.createObjectURL(Blob)': 'platform-objecturl-fetch',
	'revoked objectURL still fetchable': 'platform-objecturl-revoke',
	'navigator.serviceWorker': 'platform-navigator-serviceworker',
	'caches.keys': 'cachestorage-keys-not-namespaced',
	'caches.put fetched response': 'cachestorage-put-fetched-response',
	'indexedDB.databases': 'platform-indexeddb-databases',
	'localStorage keys': 'storage-object-keys',
	'localStorage delete and clear': 'storage-clear',
	'sessionStorage keys': 'storage-object-keys',
	'BroadcastChannel event origin': 'broadcastchannel-cross-origin-isolated',
});
