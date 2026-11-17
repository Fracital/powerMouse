// What a document's WebRTC stand-ins do the first time a page makes a
// connection (./modules/WebRTC.ts): load the library and install it, for
// this document and the ones that share its tables. A deferred part of the
// document bundle (./deferredParts.ts): most documents never make a
// connection. Its top level reads no global; what it reads of the browser
// is what the module took before the page ran.
import { rtcModule, rtcStackJS, rtcWorkerJS } from '../../routeURL';
import { closePort, onPort, privateChannel } from '../../transport/ports';
import { BUILD } from '../../version';
import WorkerModule from '../modules/Worker';
import { withStack } from '../nativeErrors';
import type { RtcLoading } from './modules/WebRTC';
import type { Installed, RtcContext, SharedTables, StackApi } from './rtcLazy';

/** the library, evaluated once for the bundle */
let api: StackApi | null = null;

/**
 * The library's text: the one a document that shares these tables loaded,
 * or one synchronous request for the asset, which the calling script waits
 * for (from the HTTP cache after the first)
 */
function libraryText(
	{ requestOpen, requestSend, requestStatus, requestText }: RtcLoading,
	shared: SharedTables,
	url: string,
): string {
	if (typeof shared.text === 'string') return shared.text;
	const request = new XMLHttpRequest();
	Reflect.apply(requestOpen, request, ['GET', url, false]);
	Reflect.apply(requestSend, request, []);
	const status: unknown = Reflect.apply(requestStatus, request, []);
	if (status !== 200)
		throw new Error(
			`STomp: the WebRTC library did not load (HTTP ${String(status)})`,
		);
	return String(Reflect.apply(requestText, request, []));
}

function loadLibrary(
	loading: RtcLoading,
	shared: SharedTables,
	url: string,
): StackApi {
	if (api) return api;
	const text = libraryText(loading, shared, url);
	// the file's own text, which names nothing of the page's: its globals
	// are this bundle's (rtcStackGlobals.ts)
	const make = Reflect.apply(loading.realmEval, undefined, [
		`(function (__stompRtcSnap, __stompRtcOut) {\n${text}\nreturn __stompRtcOut.api;\n})`,
	]) as (globals: RtcLoading['snapshot'], out: object) => StackApi;
	const made = make(loading.snapshot, {});
	if (!made || made.build !== BUILD)
		throw new Error('STomp: the WebRTC library is of another build');
	shared.text = text;
	api = made;
	return made;
}

/** what the module hands rtcInstall */
export interface RtcInstall extends Pick<
	RtcContext,
	| 'client'
	| 'realm'
	| 'shared'
	| 'proxyModule'
	| 'natives'
	| 'standIns'
	| 'captures'
> {
	/** this document's own install, which the others' loop skips */
	installNow: () => void;
	loading: RtcLoading;
}

/**
 * Install the library for this document; `set` has it before the
 * documents that share these tables install theirs (each of them installs
 * the others in turn, and finds this one done)
 */
export function rtcInstall(
	{
		client,
		realm,
		shared,
		proxyModule,
		natives,
		standIns,
		captures,
		installNow,
		loading,
	}: RtcInstall,
	set: (installed: Installed) => void,
): Installed {
	const loaded = loadLibrary(
		loading,
		shared,
		rtcStackJS(client.url, client.config),
	);
	const installed = loaded.install({
		client,
		realm,
		ports: { privateChannel, onPort, closePort },
		shared,
		proxyModule,
		workerModule: client.getModule(WorkerModule),
		withStack,
		natives,
		standIns,
		captures,
		workerURL: () => rtcWorkerJS(client.url, client.config),
		moduleURL: () => rtcModule(client.url, client.config),
	});
	set(installed);
	// the documents that share these tables have their members on
	// the browser's prototypes too: their objects are this one's
	const each = Reflect.apply(loading.setValues, shared.installs, []);
	for (;;) {
		const step = Reflect.apply(loading.setIteratorNext, each, []) as {
			done: boolean;
			value: WeakRef<() => void>;
		};
		if (step.done) break;
		const other = Reflect.apply(captures.weakDeref, step.value, []);
		if (other && other !== installNow)
			try {
				other();
			} catch (error) {
				// a document that is gone or cannot load it: its own
				// first connection tries again
			}
	}
	return installed;
}
