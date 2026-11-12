// The webrtc-lazy suite's page: what a page reads of the WebRTC classes
// before it uses them, a library that wraps a prototype's member before
// the first connection (as webrtc-adapter does), and what the page sees of
// its first connection besides the connection.
(() => {
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const classes = [
		'RTCPeerConnection',
		'RTCDataChannel',
		'RTCDataChannelEvent',
		'RTCStatsReport',
	];
	window.__lazy = {
		/** the classes' prototypes as a page reads them, without making anything */
		shape() {
			const out = {};
			for (const name of classes) {
				const prototype = window[name].prototype;
				out[name] = Reflect.ownKeys(prototype).map((key) => {
					const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
					const fn = descriptor.value ?? descriptor.get;
					return [
						String(key),
						typeof fn === 'function' ? `${fn.name}/${fn.length}` : typeof fn,
						Object.prototype.toString.call(prototype),
					].join(' ');
				});
			}
			return out;
		},
		/** a prototype's member wrapped before any connection exists, then a call over two connections */
		async adaptAndConnect() {
			const used = [];
			const original = RTCPeerConnection.prototype.setLocalDescription;
			RTCPeerConnection.prototype.setLocalDescription = function (...args) {
				used.push('wrapped');
				return original.apply(this, args);
			};
			const reports = [];
			const reporting = new ReportingObserver(
				(list) => {
					for (const report of list) reports.push(report.type);
				},
				{ buffered: true },
			);
			reporting.observe();
			const before = performance.getEntriesByType('resource').length;
			const a = new RTCPeerConnection();
			const b = new RTCPeerConnection();
			// candidates in the descriptions, not trickled: a candidate that
			// came before the other side's remote description would be refused
			const gathered = (pc) =>
				new Promise((resolve) => {
					if (pc.iceGatheringState === 'complete') resolve();
					pc.addEventListener('icegatheringstatechange', () => {
						if (pc.iceGatheringState === 'complete') resolve();
					});
				});
			const channel = a.createDataChannel('lazy');
			const heard = new Promise((resolve) => {
				b.ondatachannel = (event) => {
					event.channel.onmessage = (message) => resolve(message.data);
				};
			});
			channel.onopen = () => channel.send('first use');
			await a.setLocalDescription();
			await gathered(a);
			await b.setRemoteDescription(a.localDescription);
			await b.setLocalDescription();
			await gathered(b);
			await a.setRemoteDescription(b.localDescription);
			const message = await Promise.race([
				heard,
				wait(20000).then(() => 'none'),
			]);
			for (const report of reporting.takeRecords()) reports.push(report.type);
			a.close();
			b.close();
			return {
				message,
				used,
				reports,
				entries: performance
					.getEntriesByType('resource')
					.slice(before)
					.map((entry) => entry.name),
			};
		},
	};
	window.__lazyReady = true;
})();
