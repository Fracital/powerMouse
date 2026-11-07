// a dedicated worker: the hooks run here only with `hooks.workers`
self.onmessage = () => {
	postMessage({ pre: self.__pre || null, post: self.__post || null });
};
