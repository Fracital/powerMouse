// Classic worker for adv-workers.html: everything a worker can learn about
// where it really runs.
const safe = (fn) => {
	try {
		return fn();
	} catch (error) {
		return 'threw ' + error.name;
	}
};
self.onmessage = async (event) => {
	const out = {
		got: event.data,
		href: self.location.href,
		pathname: self.location.pathname,
		locationOrigin: self.location.origin,
		origin: self.origin,
		name: self.name,
		isWorkerScope: typeof WorkerGlobalScope !== 'undefined',
		hasWindow: typeof window !== 'undefined',
		stack: new Error('w').stack,
		evalHref: safe(() => (0, eval)('self.location.href')),
		directEvalHref: safe(() => eval('location.href')),
		FunctionHref: safe(() => new Function('return location.href')()),
		FunctionOrigin: safe(() => new Function('return self.origin')()),
		fetchToString: safe(() =>
			/\[native code\]/.test(Function.prototype.toString.call(fetch))
				? 'native'
				: 'TELL:' + Function.prototype.toString.call(fetch).slice(0, 80),
		),
		extraGlobals: safe(() =>
			Object.getOwnPropertyNames(self).filter((k) =>
				/stomp|\$s\$|createClient/i.test(k),
			),
		),
		locationDescriptor: safe(() => {
			const d = Object.getOwnPropertyDescriptor(self, 'location');
			return d ? (d.get ? d.get.call(self).href : 'value') : 'none';
		}),
		protoLocation: safe(() => {
			const d = Object.getOwnPropertyDescriptor(
				WorkerGlobalScope.prototype,
				'location',
			);
			return d ? (d.get ? d.get.call(self).href : 'value') : 'not on prototype';
		}),
		protoLocationHref: safe(() =>
			Object.getOwnPropertyDescriptor(
				WorkerLocation.prototype,
				'href',
			).get.call(self.location),
		),
		importScriptsOk: safe(() => {
			importScripts('adv-worker-dep.js');
			return self.__advDep || 'imported but no value';
		}),
	};
	try {
		const r = await fetch('/pages/echo.json');
		out.fetchUrl = r.url;
		const xhr = new XMLHttpRequest();
		await new Promise((resolve, reject) => {
			xhr.onload = resolve;
			xhr.onerror = () => reject(new Error('xhr'));
			xhr.open('GET', '/pages/echo.json');
			xhr.send();
		});
		out.xhrUrl = xhr.responseURL;
		out.requestUrl = new Request('/x').url;
		out.objectUrl = URL.createObjectURL(new Blob(['x']));
	} catch (error) {
		out.network = 'threw ' + error.name;
	}
	postMessage(out);
};
