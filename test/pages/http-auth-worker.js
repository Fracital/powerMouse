// the worker of the http-auth battery: open()'s credentials answer a Digest
// challenge, and what was kept goes ahead of the next request
onmessage = async ({ data: { key, name } }) => {
	const ask = (file, user, pass) =>
		new Promise((resolve) => {
			const request = new XMLHttpRequest();
			const url = `/auth/md5/w1/${file}?k=${key}&c=${encodeURIComponent(name)}`;
			if (user === undefined) request.open('GET', url);
			else request.open('GET', url, true, user, pass);
			request.onloadend = () => resolve(request.status);
			request.send();
		});
	const first = await ask('a', 'user', 'pass');
	const ahead = await ask('b');
	postMessage({ first, ahead });
};
