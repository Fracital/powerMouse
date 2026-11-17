// web-platform-tests workers/, what a worker's own scope shows it
// (test/wpt/workers): the top-level WorkerLocation, WorkerNavigator,
// WorkerGlobalScope and importScripts tests and the interfaces/ tests of
// the three global scopes (location, onerror, close, postMessage, the name
// of a shared worker), measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-workers-scope', {
	roots: ['workers'],
	concurrency: 1,
	globals: ['window', 'dedicatedworker', 'sharedworker'],
	// of the top-level tests, only the ones named for the scope (the rest
	// are wpt-workers-basics), and of the directories, interfaces/ without
	// WorkerUtils (wpt-workers-semantics)
	skip: [
		/^\/workers\/(?!WorkerLocation|Worker-location|WorkerNavigator|WorkerGlobalScope|importscripts_)[^/]+$/,
		/^\/workers\/(?!interfaces\/)[^/]+\//,
		/^\/workers\/interfaces\/WorkerUtils\//,
	],
});
