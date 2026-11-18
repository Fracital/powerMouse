// A call whose code is a deferred part of the document bundle
// (src/inject/dom/deferredParts.ts) refuses when the parts cannot be had,
// and never reaches the browser's own API in their place: getUserMedia, a
// position request, Notification.requestPermission, a track's settings and
// constraints, setSinkId, an AudioContext's sinkId, RTCPeerConnection, an
// XHR's misuse and its response document, an identity credential's get and
// disconnect (FedCM), a same-origin download link's click, a form a
// frame submits to its proxied parent (its submit event, or submit()) and
// a link it clicks aimed there, a link and a form's submit() aimed by name
// at a frame on its initial about:blank, a frame's navigation of another
// window (`w.location = url`); and a call of no function through the
// access API throws the TypeError the call threw (only its wording is a
// part, src/inject/accessFailures.ts); navigator.storage.estimate()
// rejects before the browser is asked (src/inject/storageUsage.ts); a
// Worker's construction throws before the browser's
// (src/inject/workerStart.ts), and so do a WebSocket's and a
// WebSocketStream's (src/inject/bareClient.ts socketStandIns) and a
// fetchLater() call (src/inject/dom/fetchLater.ts); an image in a frame
// no service worker controls keeps its route and loads nothing (its copy
// is a part, src/inject/dom/uncontrolledCopies.ts); an XML document a
// frame loads lands none of its tree (its load is a part,
// src/inject/dom/instructions.ts); a protocol handler's registration throws
// (its checks are a part, src/inject/dom/protocolHandlers.ts); execCommand's
// insertHTML and Range's createContextualFragment throw before the browser
// parses the markup (src/inject/dom/markupSinks.ts); window.open() throws
// and opens nothing (src/inject/dom/windowOpen.ts); under a policy of the
// page's own that allows them, an eval throws, and an inline script and an
// inline style the page inserts run and apply nothing, and a frame it
// refuses still loads nothing (the policy's checks are a part,
// src/inject/dom/policyChecks.ts); a document the page makes in a frame
// whose shell is a part (src/htmlShell.ts: an srcdoc, a javascript: URL's
// markup; a data: frame, src/inject/dom/rareAttributes.ts) is never given
// to the frame, unrewritten or at all, and a refresh meta has no content
// for the browser; a base a report-only base-uri refuses is refused, its
// report being a part. A part is made synchronously within the call that
// needs it, so no page code runs between the hook and the part (a
// download's copy is made after the click went through the page, which the
// browser's own download had been cancelled for as it started); what is
// left to check is the part that throws instead.
//
// The tab's documents get, before any script of theirs (and so before the
// inject takes the browser's functions), counting stand-ins for the
// browser's functions behind those calls: the ones that would ask for a
// device, a position, a permission or a credential refuse instead of
// asking. The proxied top then hands a frame under it a parts statement
// that throws (as one of another build, deferred-parts, would hand none),
// and the frame makes the calls: each throws, or rejects where the call
// answers with a promise; an XHR with a document response refuses (its
// open() throws, since the method check is a part too, xhrChecks.ts; a
// request past it fails as on a network error: its error event, no
// document); a download link saves nothing (neither the copy nor the
// browser's download of the route); a form aimed at the frame navigates
// nothing (neither the copy nor the browser's own submission); and no
// stand-in counted a call. The same frame with the parts counts the calls
// that do reach the browser (a track's settings, the XHR document's
// request), gets FedCM's answers, saves the download and lands where the
// form went, so neither count is vacuous.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	waitActive,
} from '../lib.mjs';

const target = `${FIXTURE}pages/deferred-refusals.html`;
/**
 * The calls the page's own policy judges (a meta the child inserts first,
 * which allows the code and refuses the frame: the checks are a deferred
 * part, src/inject/dom/policyChecks.ts), made last: an eval, an inline
 * script and style, a frame. (A synchronous request's and a WebSocket's checks are
 * reached only past parts of their own, xhrChecks.ts and bareClient.ts)
 */
const POLICED = ['cspEval', 'cspScript', 'cspStyle', 'cspFrame'];
const REFUSING = [
	'getUserMedia',
	'getCurrentPosition',
	'watchPosition',
	'requestPermission',
	'getSettings',
	'applyConstraints',
	'setSinkId',
	'audioContext',
	'peer',
	'peerSubclass',
	'peerReflect',
	'webkitPeer',
	'misuse',
	'xmlDocument',
	'identity',
	'disconnect',
	'download',
	'blankLink',
	'blankSubmit',
	'navigateOther',
	'estimate',
	'worker',
	'protocolHandler',
	'webSocket',
	'webSocketStream',
	'fetchLater',
	'execCommand',
	'contextualFragment',
	'open',
];
/**
 * the documents a frame of the child is given whose code is a part, asked
 * on their own (each waits a while for what does not come)
 */
const DOCUMENTS = ['srcdoc', 'javascriptDocument', 'dataFrame', 'refresh'];
/**
 * the refusing calls that navigate the child itself unless refused, each
 * made in a child of its own: one let through would answer for the others
 */
const AIMED = ['formAimed', 'submitAimed', 'linkAimed'];
/** the calls that answer with a promise, which rejects */
const PROMISED = [
	'getUserMedia',
	'requestPermission',
	'setSinkId',
	'applyConstraints',
	'identity',
	'disconnect',
	'estimate',
];

/** counting stand-ins for the browser's functions, in every document */
function countNatives() {
	const reached = (window.__nativeReached = []);
	const refuse = (name) =>
		function () {
			reached.push(name);
			return Promise.reject(new Error('the browser was asked'));
		};
	const counted = (name, native) =>
		function (...args) {
			reached.push(name);
			return Reflect.apply(native, this, args);
		};
	const constructs = (name, Native) =>
		new Proxy(Native, {
			construct(target, args, newTarget) {
				reached.push(name);
				return Reflect.construct(target, args, newTarget);
			},
		});
	if (window.MediaDevices)
		MediaDevices.prototype.getUserMedia = refuse('getUserMedia');
	if (window.Geolocation) {
		Geolocation.prototype.getCurrentPosition = function () {
			reached.push('getCurrentPosition');
		};
		Geolocation.prototype.watchPosition = function () {
			reached.push('watchPosition');
			return 0;
		};
	}
	if (window.Notification)
		Notification.requestPermission = refuse('requestPermission');
	if (window.HTMLMediaElement)
		HTMLMediaElement.prototype.setSinkId = refuse('setSinkId');
	if (window.AudioContext) {
		AudioContext.prototype.setSinkId = refuse('setSinkId');
		window.AudioContext = constructs('AudioContext', AudioContext);
	}
	if (window.MediaStreamTrack) {
		const prototype = MediaStreamTrack.prototype;
		for (const name of ['getSettings', 'applyConstraints'])
			prototype[name] = counted(name, prototype[name]);
	}
	if (window.Worker) window.Worker = constructs('Worker', Worker);
	if (Navigator.prototype.registerProtocolHandler)
		Navigator.prototype.registerProtocolHandler = function () {
			reached.push('registerProtocolHandler');
		};
	if (window.WebSocket)
		window.WebSocket = constructs('WebSocket', window.WebSocket);
	if (window.WebSocketStream)
		window.WebSocketStream = constructs(
			'WebSocketStream',
			window.WebSocketStream,
		);
	if (window.fetchLater)
		window.fetchLater = counted('fetchLater', window.fetchLater);
	Document.prototype.execCommand = counted(
		'execCommand',
		Document.prototype.execCommand,
	);
	Range.prototype.createContextualFragment = counted(
		'createContextualFragment',
		Range.prototype.createContextualFragment,
	);
	// (opens nothing: the page gets null, as from a popup blocker)
	window.open = function () {
		reached.push('open');
		return null;
	};
	if (window.StorageManager) {
		const prototype = StorageManager.prototype;
		prototype.estimate = counted('estimate', prototype.estimate);
	}
	if (window.RTCPeerConnection)
		window.RTCPeerConnection = constructs(
			'RTCPeerConnection',
			RTCPeerConnection,
		);
	if (window.CredentialsContainer) {
		const identityGet = refuse('credentialsGet');
		// only an identity request is FedCM's: the passkeys part asks the
		// browser's get which members it reads, with an object that names
		// none, and reaches no authenticator
		CredentialsContainer.prototype.get = function (options) {
			if (options?.identity !== undefined) return identityGet();
			return Promise.reject(new Error('the browser was asked'));
		};
	}
	if (window.IdentityCredential)
		IdentityCredential.disconnect = refuse('disconnect');
	// a document's markup the page made that reaches the browser as it is:
	// an srcdoc, or a frame's data: URL, with no shell (`createClient` is in
	// every shell's script)
	const raw = (name, value) =>
		((/^srcdoc$/i.test(name) ||
			(/^src$/i.test(name) && /^\s*data:text\/html/i.test(value))) &&
			!value.includes('createClient')) ||
		// (and a refresh meta's content, unrouted)
		(/^content$/i.test(name) && /url=deferred-refusals-landed/.test(value));
	const setAttribute = Element.prototype.setAttribute;
	Element.prototype.setAttribute = function (name, value) {
		if (raw(String(name), String(value))) reached.push('rawDocument');
		return Reflect.apply(setAttribute, this, [name, value]);
	};
	const setAttributeNS = Element.prototype.setAttributeNS;
	Element.prototype.setAttributeNS = function (namespace, name, value) {
		if (raw(String(name), String(value))) reached.push('rawDocument');
		return Reflect.apply(setAttributeNS, this, [namespace, name, value]);
	};
	// the realm's own request the inject makes a response document with
	const open = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (...args) {
		const url = String(args[1]);
		if (url.startsWith('data:') || url.includes('/echo/'))
			reached.push('xhrDocument');
		return Reflect.apply(open, this, args);
	};
}

const browser = await launch();
const page = await openDemo(browser, PROXY);
await page.addInitScript(countNatives);
// a download the browser starts, the proxy's copy or its own of the route
const downloads = [];
page.on('download', (download) => downloads.push(download.suggestedFilename()));
/** the downloads started since `from`, once a click's copy had time to land */
const downloadsSince = async (from) => {
	await sleep(1500);
	return downloads.slice(from);
};
await submitLanding(page, target);
const top = await waitActive(page, `typeof window.__child === 'function'`);
const name = await page.evaluate(() => window.controller.config.names.client);

// with the parts: what reaches the browser is counted
{
	const from = downloads.length;
	const answer = await top.evaluate(
		(calls) => window.__child(calls),
		[
			'getSettings',
			'xmlDocument',
			'identity',
			'disconnect',
			'download',
			'notFunction',
			'estimate',
			'worker',
			'blankCopy',
			'xmlLoad',
			'protocolHandler',
			'webSocket',
			'webSocketStream',
			'fetchLater',
			'execCommand',
			'contextualFragment',
			'open',
			...POLICED,
		],
	);
	const documents = await top.evaluate(
		(calls) => window.__child(calls),
		DOCUMENTS,
	);
	ok(
		'with the parts, the counting stand-ins see the calls that reach the browser',
		answer.out?.getSettings?.returned === 'object' &&
			answer.out?.xmlDocument?.document === '[object XMLDocument]' &&
			answer.reached?.includes('getSettings') &&
			answer.reached?.includes('xhrDocument'),
		JSON.stringify(answer),
	);
	ok(
		'with the parts, an image in a frame no service worker controls loads its copy',
		answer.out?.blankCopy?.loaded === true,
		JSON.stringify(answer.out?.blankCopy),
	);
	for (const call of ['srcdoc', 'javascriptDocument'])
		ok(
			`with the parts, a document the page makes (${call}) runs in its shell`,
			documents.out?.[call]?.ran === 'injected' &&
				Array.isArray(documents.reached) &&
				documents.reached.length === 0,
			JSON.stringify({
				out: documents.out?.[call],
				reached: documents.reached,
			}),
		);
	ok(
		'with the parts, an XML document a frame loads lands its tree',
		answer.out?.xmlLoad?.root === 'svg' && answer.out.xmlLoad.landed === true,
		JSON.stringify(answer.out?.xmlLoad),
	);
	ok(
		'with the parts, a protocol handler is accepted, without the browser',
		answer.out?.protocolHandler?.returned === 'undefined' &&
			!answer.reached?.includes('registerProtocolHandler'),
		JSON.stringify({
			out: answer.out?.protocolHandler,
			reached: answer.reached,
		}),
	);
	ok(
		'with the parts, a data: frame shows its document',
		documents.out?.dataFrame?.ran === 'data',
		JSON.stringify(documents.out?.dataFrame),
	);
	ok(
		'with the parts, a refresh meta a script inserts refreshes its frame',
		documents.out?.refresh?.refreshed === true,
		JSON.stringify(documents.out?.refresh),
	);
	const based = await top.evaluate(() => window.__baseIn());
	ok(
		'with the parts, a base a report-only base-uri refuses applies and is reported',
		based.baseURI === 'https://base.example/based/' &&
			based.events?.includes('base-uri https://base.example/based/ report'),
		JSON.stringify(based),
	);
	ok(
		'with the parts, a worker starts, through the browser',
		answer.out?.worker?.returned === 'object' &&
			answer.reached?.includes('Worker'),
		JSON.stringify({ out: answer.out?.worker, reached: answer.reached }),
	);
	// a URL the browser refuses (a fragment): its own SyntaxError, from its
	// own constructor, through the stand-in's part
	ok(
		"with the parts, a WebSocket and a WebSocketStream to a URL the browser refuses get the browser's error, from its constructor",
		/SyntaxError|is invalid|fragment/i.test(
			answer.out?.webSocket?.threw ?? '',
		) &&
			/SyntaxError|is invalid|fragment/i.test(
				answer.out?.webSocketStream?.threw ?? '',
			) &&
			answer.reached?.filter((name) => name === 'WebSocket').length === 2 &&
			!answer.reached?.includes('WebSocketStream'),
		JSON.stringify({
			ws: answer.out?.webSocket,
			stream: answer.out?.webSocketStream,
			reached: answer.reached,
		}),
	);
	// a URL fetchLater cannot defer (no http(s)): the browser's own refusal
	ok(
		"with the parts, fetchLater of a data: URL is the browser's own call",
		typeof answer.out?.fetchLater?.threw === 'string' &&
			answer.out.fetchLater.threw !== 'no parts' &&
			answer.reached?.includes('fetchLater'),
		JSON.stringify({ out: answer.out?.fetchLater, reached: answer.reached }),
	);
	ok(
		"with the parts, execCommand's insertHTML and createContextualFragment reach the browser",
		answer.out?.execCommand?.returned === 'boolean' &&
			answer.out?.contextualFragment?.returned === 'object' &&
			answer.reached?.includes('execCommand') &&
			answer.reached?.includes('createContextualFragment'),
		JSON.stringify({
			execCommand: answer.out?.execCommand,
			contextualFragment: answer.out?.contextualFragment,
			reached: answer.reached,
		}),
	);
	ok(
		'with the parts, window.open() reaches the browser',
		answer.out?.open?.returned === 'object' && answer.reached?.includes('open'),
		JSON.stringify({ out: answer.out?.open, reached: answer.reached }),
	);
	ok(
		'with the parts, an estimate answers, through the browser',
		answer.out?.estimate?.promise === 'resolved' &&
			answer.reached?.includes('estimate'),
		JSON.stringify({ out: answer.out?.estimate, reached: answer.reached }),
	);
	ok(
		"with the parts, a call of no function names the page's expression",
		answer.out?.notFunction?.threw === 'o[k] is not a function',
		JSON.stringify(answer.out?.notFunction),
	);
	ok(
		"with the parts, what the page's own policy allows runs and applies, and the frame it refuses loads nothing",
		answer.out?.cspEval?.returned === 'number' &&
			answer.out?.cspScript?.ran === true &&
			answer.out?.cspStyle?.color === 'rgb(1, 2, 3)' &&
			answer.out?.cspFrame?.title === null,
		JSON.stringify(POLICED.map((call) => answer.out?.[call])),
	);
	const navigated = await top.evaluate(
		(calls) => window.__child(calls),
		['navigateOther'],
	);
	ok(
		'with the parts, a frame navigates a window of its own',
		navigated.out?.navigateOther?.at === '?moved',
		JSON.stringify(navigated.out?.navigateOther),
	);
	// (each navigates the child: the page it lands on answers)
	for (const [call, landed, what] of [
		['formAimed', '?x=1', 'a form a frame aims at its parent'],
		['submitAimed', '?y=2', 'a form a frame aims at its parent, by submit(),'],
		['linkAimed', '?link', 'a link a frame aims at its parent'],
	]) {
		const aimed = await top.evaluate((calls) => window.__child(calls), [call]);
		ok(
			`with the parts, ${what} lands there`,
			aimed.landed === landed,
			JSON.stringify(aimed),
		);
	}
	const blank = await top.evaluate(
		(calls) => window.__child(calls),
		['blankLink', 'blankSubmit'],
	);
	ok(
		'with the parts, a link and a form aimed by name at a frame on its initial about:blank land there',
		blank.out?.blankLink?.inFrame === '?blank' &&
			blank.out?.blankSubmit?.inFrame === '?z=3' &&
			blank.out.blankSubmit.threw === null,
		JSON.stringify(blank.out),
	);
	// FedCM's protocol answers (the browser's get is never asked for an
	// identity, with the parts or without)
	const answered = (call) =>
		/^rejected: (?!no parts|pending)/.test(answer.out?.[call]?.promise ?? '');
	ok(
		"with the parts, FedCM's protocol answers an identity get and a disconnect",
		answered('identity') &&
			answered('disconnect') &&
			!answer.reached?.includes('credentialsGet') &&
			!answer.reached?.includes('disconnect'),
		JSON.stringify(answer.out),
	);
	const saved = await downloadsSince(from);
	ok(
		'with the parts, a download link saves its copy',
		saved.length === 1 && saved[0] === 'refusals.html',
		JSON.stringify(saved),
	);
}

// without them: every call refuses, and nothing reaches the browser
{
	const from = downloads.length;
	const without = (calls) =>
		top.evaluate(
			async ({ name, calls }) => {
				const client = window[name];
				Reflect.defineProperty(client, 'deferredPartsText', {
					configurable: true,
					value: () =>
						'__stompDeferred=function(){throw new Error("no parts")};',
				});
				try {
					return await window.__child(calls);
				} finally {
					Reflect.deleteProperty(client, 'deferredPartsText');
				}
			},
			{ name, calls },
		);
	// (the frame loads with the parts, its base is given without them)
	const based = await top.evaluate(
		(name) =>
			window
				.__baseIn(() =>
					Reflect.defineProperty(window[name], 'deferredPartsText', {
						configurable: true,
						value: () =>
							'__stompDeferred=function(){throw new Error("no parts")};',
					}),
				)
				.finally(() =>
					Reflect.deleteProperty(window[name], 'deferredPartsText'),
				),
		name,
	);
	const answer = await without([
		...REFUSING,
		'foreignStats',
		'notFunction',
		'blankCopy',
		'xmlLoad',
		...POLICED,
	]);
	const documents = await without(DOCUMENTS);
	const out = { ...answer.out, ...documents.out };
	// (a child that was navigated answers with the page it landed on)
	for (const call of AIMED) {
		const aimed = await without([call]);
		out[call] = aimed.out?.[call] ?? aimed;
	}
	// the parts' own error; an identity get with STomp's passkey provider
	// in place goes to it, whose part is missing too: it ends as one the
	// user declined (Credentials DECLINED), never at the browser's get
	const refusedPromise = (call) =>
		/^rejected: no parts/.test(out[call]?.promise ?? '') ||
		(call === 'identity' &&
			/^rejected: The operation either timed out or was not allowed/.test(
				out[call]?.promise ?? '',
			));
	// the parts' own error, not one of the browser's after a fall-through
	const refused = (call) =>
		out[call]?.threw === 'no parts' || refusedPromise(call);
	for (const call of REFUSING.filter(
		(call) =>
			![
				'xmlDocument',
				'download',
				'blankLink',
				'blankSubmit',
				'navigateOther',
			].includes(call),
	))
		ok(
			`without the parts, ${call} refuses${
				PROMISED.includes(call) ? ' with a rejected promise' : ''
			}`,
			PROMISED.includes(call)
				? refusedPromise(call)
				: refused(call) || (call === 'webkitPeer' && out[call]?.absent),
			JSON.stringify(out[call]),
		);
	ok(
		'without the parts, an XHR document response refuses, with no document',
		out.xmlDocument?.threw === 'no parts' ||
			(out.xmlDocument?.document === 'null' &&
				out.xmlDocument.events.join() === 'error,loadend'),
		JSON.stringify(out.xmlDocument),
	);
	ok(
		'without the parts, a WebRTC member on an object no connection made answers as the browser does',
		/^rejected: .*Illegal invocation|^rejected: .*not of type/.test(
			out.foreignStats?.promise ?? '',
		) || /Illegal invocation/.test(out.foreignStats?.threw ?? ''),
		JSON.stringify(out.foreignStats),
	);
	// the frame gets no document of the markup: an srcdoc is not set, a
	// javascript: URL throws in the frame (its document stays)
	ok(
		'without the parts, an srcdoc is refused: the frame gets no srcdoc',
		out.srcdoc?.ran === false && out.srcdoc.srcdoc === false,
		JSON.stringify(out.srcdoc),
	);
	ok(
		"without the parts, a javascript: URL's markup is refused: the frame keeps its document",
		out.javascriptDocument?.ran === false,
		JSON.stringify(out.javascriptDocument),
	);
	ok(
		'without the parts, a data: frame is refused: it is not navigated',
		out.dataFrame?.ran === false,
		JSON.stringify(out.dataFrame),
	);
	ok(
		'without the parts, a refresh meta is refused: its frame stays',
		out.refresh?.stayed === true,
		JSON.stringify(out.refresh),
	);
	// as an enforced base-uri refuses it: the browser refuses its refusal
	// URL, and nothing reports the page's own base
	// it applies to nothing: the document's base URL is its own
	ok(
		'without the parts, a base a report-only base-uri refuses is refused and not reported',
		Array.isArray(based.events) &&
			!based.events.some((event) => event.includes('base.example')) &&
			based.baseURI === based.documentURL,
		JSON.stringify(based),
	);
	ok(
		'without the parts, a form a frame aims at its parent navigates nothing, neither the copy nor the browser',
		out.formAimed?.stayed === true,
		JSON.stringify(out.formAimed),
	);
	ok(
		"without the parts, a frame's submit() of a form aimed at its parent throws and navigates nothing",
		out.submitAimed?.stayed === true && out.submitAimed.threw === 'no parts',
		JSON.stringify(out.submitAimed),
	);
	ok(
		'without the parts, a link a frame aims at its parent navigates nothing, neither the window nor the browser',
		out.linkAimed?.stayed === true,
		JSON.stringify(out.linkAimed),
	);
	ok(
		'without the parts, a link aimed by name at a frame on its initial about:blank navigates nothing',
		out.blankLink?.stayed === true && out.blankLink.at === 'about:blank',
		JSON.stringify(out.blankLink),
	);
	ok(
		'without the parts, a submit() aimed by name at a frame on its initial about:blank throws and navigates nothing',
		out.blankSubmit?.stayed === true &&
			out.blankSubmit.threw === 'no parts' &&
			out.blankSubmit.at === 'about:blank',
		JSON.stringify(out.blankSubmit),
	);
	ok(
		'without the parts, a navigation of another window throws and navigates nothing',
		out.navigateOther?.threw === 'no parts' && out.navigateOther?.at === '',
		JSON.stringify(out.navigateOther),
	);
	// no copy: the image keeps its route, which fails from the proxy
	// origin's own server, as a failed copy does, and nothing is thrown
	ok(
		'without the parts, an image in a frame no service worker controls loads nothing',
		out.blankCopy?.loaded === false,
		JSON.stringify(out.blankCopy),
	);
	// the shell's call throws: none of the document's tree lands
	ok(
		'without the parts, an XML document a frame loads lands nothing',
		out.xmlLoad?.root === 'svg' && out.xmlLoad.landed === false,
		JSON.stringify(out.xmlLoad),
	);
	// the part only words the error: without it, the error the call threw
	ok(
		'without the parts, a call of no function throws the TypeError of the call',
		typeof out.notFunction?.threw === 'string' &&
			out.notFunction.threw !== 'no parts' &&
			/not a function|was called on/.test(out.notFunction.threw),
		JSON.stringify(out.notFunction),
	);
	// the page's own policy's checks: each refuses (an eval throws, an
	// inline script and style run and apply nothing, and the refused frame
	// still loads nothing), never lets the code through
	ok(
		"without the parts, an eval under the page's own policy throws",
		out.cspEval?.threw === 'no parts',
		JSON.stringify(out.cspEval),
	);
	ok(
		"without the parts, an inline script under the page's own policy runs nothing",
		out.cspScript?.ran === false,
		JSON.stringify(out.cspScript),
	);
	ok(
		"without the parts, an inline style under the page's own policy applies nothing",
		typeof out.cspStyle?.color === 'string' &&
			out.cspStyle.color !== 'rgb(1, 2, 3)',
		JSON.stringify(out.cspStyle),
	);
	ok(
		"without the parts, a frame the page's own policy refuses loads nothing",
		out.cspFrame?.title === null,
		JSON.stringify(out.cspFrame),
	);
	const saved = await downloadsSince(from);
	ok(
		'without the parts, a download link saves nothing, neither the copy nor the route',
		saved.length === 0,
		JSON.stringify(saved),
	);
	ok(
		'without the parts, no call reaches the browser',
		Array.isArray(answer.reached) &&
			answer.reached.length === 0 &&
			Array.isArray(documents.reached) &&
			documents.reached.length === 0,
		JSON.stringify([answer.reached, documents.reached]),
	);
}

await done(browser);
