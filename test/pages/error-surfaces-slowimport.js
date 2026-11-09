// a worker terminated during an import of its own (error-surfaces)
postMessage('importing');
importScripts('/slow-js?ms=3000');
