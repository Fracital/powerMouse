// The shared worker of workers.html: every connection gets the count so far.
var connections = 0;
self.onconnect = function (event) {
	connections++;
	var port = event.ports[0];
	port.postMessage([connections, self.location.href, self.origin, self.name]);
};
