// sop-partitions: a shared worker that answers each connection with how many
// documents have connected to it so far, and what it sees of each store
importScripts('sop-part-list.js');
let count = 0;
onconnect = (event) => {
	count++;
	const port = event.ports[0];
	port.onmessage = async (message) => {
		if (message.data !== 'seen') return port.postMessage(count);
		try {
			port.postMessage(await self.listStores());
		} catch (error) {
			port.postMessage({ error: `${error.name}: ${error.message}` });
		}
	};
};
