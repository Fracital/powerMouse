// a worker that imports nothing (worker-terminated)
onmessage = (event) => postMessage(event.data);
