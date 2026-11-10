// sop-partitions: a shared worker that answers each connection with how many
// documents have connected to it so far
let count = 0;
onconnect = (event) => {
	count++;
	const port = event.ports[0];
	port.onmessage = () => port.postMessage(count);
};
