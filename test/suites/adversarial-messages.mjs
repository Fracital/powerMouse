// postMessage both ways: what a message from the host looks like to the page
// (source, origin, the native getters behind them), where a message to
// parent / top goes (the runner listens on the host), targetOrigin against the
// spoofed origin, BroadcastChannel origins, and the shape of the postMessage
// property (test/pages/adv-messages.html).
import { runGroup } from '../adversarial.mjs';

await runGroup('messages', {
	'host message': 'escapes-postmessage-source-eval',
	'host message source eval': 'escapes-postmessage-source-eval',
	'o.postMessage identity': 'pmwrap-identity',
	'MessagePort.postMessage identity': 'pmwrap-identity',
	'postMessage name/length': 'pmwrap-function-shape',
	'postMessage getter invoked once': 'pmwrap-getter-invocation-count',
	'postMessage assignment sticks': 'pmwrap-assignment',
	'delete o.postMessage': 'pmwrap-delete',
	'MessagePort.prototype.postMessage.call': 'pmwrap-prototype-method',
	'detached postMessage loses receiver': 'pmwrap-detached-loses-receiver',
	'MessageChannel event': 'pmwrap-messagechannel',
	'BroadcastChannel event': 'broadcastchannel-cross-origin-isolated',
});
