// The legacy file system's Sync forms in a dedicated worker (legacy-fs.html)
const out = {};
const E = (e) => `${e.name}|${e.message}`;
try {
	const fs = webkitRequestFileSystemSync(TEMPORARY, 1024);
	out.name = fs.name;
	out.root = [fs.root.fullPath, fs.root.name, fs.root.toURL()];
	out.parent = fs.root.getParent().fullPath;
	const d = fs.root.getDirectory('wd', { create: true });
	const f = d.getFile('../../w.txt', { create: true });
	out.clamp = [f.fullPath, f.toURL(), f.name];
	try {
		fs.root.remove();
	} catch (e) {
		out.removeRoot = E(e);
	}
	try {
		fs.root.removeRecursively();
	} catch (e) {
		out.removeRootRecursively = E(e);
	}
	out.resolve = webkitResolveLocalFileSystemSyncURL(f.toURL()).fullPath;
	const root = webkitResolveLocalFileSystemSyncURL(fs.root.toURL());
	out.resolveRoot = [root.fullPath, root.name, root.filesystem.name];
	try {
		webkitResolveLocalFileSystemSyncURL(
			'filesystem:http://example.com/temporary/a',
		);
	} catch (e) {
		out.foreign = E(e);
	}
	out.list = fs.root
		.createReader()
		.readEntries()
		.map((e) => e.fullPath)
		.sort();
	out.async = typeof webkitRequestFileSystem;
} catch (e) {
	out.threw = E(e);
}
postMessage(out);
