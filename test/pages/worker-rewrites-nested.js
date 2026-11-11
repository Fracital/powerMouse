// a worker started by worker-rewrites.js: what it evaluates for each
// message
const made = (self.__made = {});
onmessage = (event) => {
	const fn = new Function('/* kept */ return [location.href, typeof top];');
	made[event.data] = fn;
	postMessage([String(fn), fn(), eval('location.pathname')]);
};
