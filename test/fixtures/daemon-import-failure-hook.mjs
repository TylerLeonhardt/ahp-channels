export async function load(url, context, nextLoad) {
	if (/\/daemonServer\.(?:ts|js)$/.test(new URL(url).pathname)) {
		throw new Error('fixture runtime import failure');
	}
	return nextLoad(url, context);
}
