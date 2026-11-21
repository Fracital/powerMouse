// The SharedWorker of shared-transport.js: one for every tab of the
// fixture's origin, each connection numbered, each transport's word told on
// the channel the transport-worker suite's host pages hear.
const instance = Math.random().toString(36).slice(2);
const channel = new BroadcastChannel('stomp-shared-transport');
let connections = 0;
self.addEventListener('connect', ({ ports: [port] }) => {
	const connection = ++connections;
	port.onmessage = ({ data }) =>
		channel.postMessage({ instance, connection, realm: data?.realm });
});
