// The permission warnings Chrome's install dialog lists ("It can:"), from a
// manifest, as Chromium makes them: its permission ids
// (chrome_api_permissions.cc, extensions_api_permissions.cc) and the
// message rules of chrome_permission_message_rules.cc, applied in order,
// each taking the ids it needs and the ones it absorbs, so "Read and change
// all your data on all websites" stands for tabs, webNavigation and every
// site too. The sites are the required host permissions and the content
// scripts' matches (PermissionsParser's required set: optional permissions
// ask later, and say nothing here); permission_message_util.cc names them.

/** one line of the dialog, with the lines below it (the sites of "a number of websites") */
export interface PermissionMessage {
	message: string;
	details: string[];
}

/** a manifest permission's id, where Chrome words one */
const IDS: Record<string, string> = {
	debugger: 'debugger',
	tabs: 'tab',
	sessions: 'sessions',
	history: 'history',
	processes: 'processes',
	webNavigation: 'webNavigation',
	declarativeNetRequestFeedback: 'dnrFeedback',
	declarativeNetRequest: 'dnr',
	declarativeWebRequest: 'declarativeWebRequest',
	favicon: 'favicon',
	topSites: 'topSites',
	printing: 'printing',
	printingMetrics: 'printingMetrics',
	audioCapture: 'audioCapture',
	videoCapture: 'videoCapture',
	geolocation: 'geolocation',
	usb: 'usb',
	printerProvider: 'printerProvider',
	bluetooth: 'bluetooth',
	serial: 'serial',
	u2fDevices: 'u2fDevices',
	notifications: 'notifications',
	'accessibilityFeatures.modify': 'a11yModify',
	'accessibilityFeatures.read': 'a11yRead',
	'fileSystem.write': 'fileSystemWrite',
	'fileSystem.directory': 'fileSystemDirectory',
	'networking.onc': 'networkingOnc',
	networkingPrivate: 'networkingPrivate',
	vpnProvider: 'vpn',
	bookmarks: 'bookmarks',
	readingList: 'readingList',
	clipboardRead: 'clipboardRead',
	clipboardWrite: 'clipboardWrite',
	desktopCapture: 'desktopCapture',
	downloads: 'downloads',
	'downloads.open': 'downloadsOpen',
	'identity.email': 'identityEmail',
	'system.storage': 'systemStorage',
	contentSettings: 'contentSettings',
	documentScan: 'documentScan',
	input: 'input',
	management: 'management',
	mdns: 'mdns',
	nativeMessaging: 'nativeMessaging',
	privacy: 'privacy',
	syncFileSystem: 'syncFileSystem',
	tabGroups: 'tabGroups',
	ttsEngine: 'ttsEngine',
	wallpaper: 'wallpaper',
	platformKeys: 'platformKeys',
	certificateProvider: 'certificateProvider',
	'enterprise.hardwarePlatform': 'enterpriseHardwarePlatform',
	'enterprise.deviceAttributes': 'enterpriseDeviceAttributes',
	'enterprise.webrtc': 'enterpriseWebrtc',
	'enterprise.kioskInput': 'enterpriseKioskInput',
	'enterprise.login': 'enterpriseLogin',
	'enterprise.networkingAttributes': 'enterpriseNetworkingAttributes',
	'enterprise.platformKeys': 'enterprisePlatformKeys',
	'omnibox.directInput': 'omniboxDirectInput',
	transientBackground: 'transientBackground',
	webAuthenticationProxy: 'webAuthenticationProxy',
};

/** the permissions that reach every site (kFlagImpliesFullURLAccess) */
const FULL_URL_ACCESS = new Set([
	'debugger',
	'pageCapture',
	'tabCapture',
	'proxy',
	'devtools',
]);

const ALL_HOSTS = 'Read and change all your data on all websites';
const HISTORY_READ = 'Read your browsing history';

/** [message, the ids it needs, the ids it absorbs], in Chromium's order */
type Rule = [string | 'hosts', string[], string[]];
const RULES: Rule[] = [
	['Access the page debugger backend', ['debugger'], []],
	[
		ALL_HOSTS,
		['hostsAll'],
		[
			'declarativeWebRequest',
			'dnrFeedback',
			'favicon',
			'host',
			'processes',
			'tab',
			'topSites',
			'webNavigation',
			'dnr',
			'webAuthenticationProxy',
		],
	],
	[
		ALL_HOSTS,
		['webAuthenticationProxy'],
		[
			'declarativeWebRequest',
			'dnrFeedback',
			'favicon',
			'host',
			'processes',
			'tab',
			'topSites',
			'webNavigation',
			'dnr',
		],
	],
	['hosts', ['host'], []],
	['Replace the page you see when opening a new tab', ['newTabPage'], []],
	['Use your microphone and camera', ['audioCapture', 'videoCapture'], []],
	['Use your microphone', ['audioCapture'], []],
	['Use your camera', ['videoCapture'], []],
	['Detect your physical location', ['geolocation'], []],
	[
		'Read and change your browsing history on all your signed-in devices',
		['history'],
		['dnrFeedback', 'favicon', 'processes', 'tab', 'topSites', 'webNavigation'],
	],
	[
		'Read your browsing history on all your signed-in devices',
		['tab', 'sessions'],
		['dnrFeedback', 'favicon', 'processes', 'topSites', 'webNavigation'],
	],
	[
		HISTORY_READ,
		['tab'],
		['dnrFeedback', 'favicon', 'processes', 'topSites', 'webNavigation'],
	],
	[
		HISTORY_READ,
		['processes'],
		['dnrFeedback', 'favicon', 'topSites', 'webNavigation'],
	],
	[HISTORY_READ, ['webNavigation'], ['dnrFeedback', 'favicon', 'topSites']],
	[HISTORY_READ, ['dnrFeedback'], ['favicon', 'topSites']],
	['Read the icons of the websites you visit', ['favicon'], []],
	['Read a list of your most frequently visited websites', ['topSites'], []],
	['Access your printers', ['printing'], []],
	['See your printing history', ['printingMetrics'], []],
	['Block parts of web pages', ['declarativeWebRequest'], []],
	['Block content on any page', ['dnr'], []],
	['Access USB devices from an unknown vendor', ['usb', 'printerProvider'], []],
	['Access your Bluetooth and Serial devices', ['bluetooth', 'serial'], []],
	[
		'Access information about Bluetooth devices paired with your system and discover nearby Bluetooth devices.',
		['bluetooth'],
		[],
	],
	['Access your serial devices', ['serial'], []],
	['Access your Universal 2nd Factor devices', ['u2fDevices'], []],
	['Display notifications', ['notifications'], []],
	[
		'Read and change your accessibility settings',
		['a11yModify', 'a11yRead'],
		[],
	],
	['Change your accessibility settings', ['a11yModify'], []],
	['Read your accessibility settings', ['a11yRead'], []],
	[
		'Write to files and folders that you open in the application',
		['fileSystemWrite', 'fileSystemDirectory'],
		[],
	],
	[
		'Read folders that you open in the application',
		['fileSystemDirectory'],
		[],
	],
	['Manage network connections', ['networkingOnc'], ['networkingPrivate']],
	['Manage network connections', ['networkingPrivate'], []],
	['Access your network traffic', ['vpn'], []],
	['homepage', ['homepage'], []],
	['searchProvider', ['searchProvider'], []],
	['startupPages', ['startupPages'], []],
	['Read and change your bookmarks', ['bookmarks'], []],
	['Read and change entries in the reading list', ['readingList'], []],
	[
		'Read and modify data you copy and paste',
		['clipboardRead', 'clipboardWrite'],
		[],
	],
	['Read data you copy and paste', ['clipboardRead'], []],
	['Modify data you copy and paste', ['clipboardWrite'], []],
	['Capture content of your screen', ['desktopCapture'], []],
	['Manage your downloads', ['downloads'], []],
	['Open downloaded files', ['downloadsOpen'], []],
	['Know your email address', ['identityEmail'], []],
	['Identify and eject storage devices', ['systemStorage'], []],
	[
		'Change and grant access to features such as geolocation, microphone, camera, cookies, etc., for all your websites and extensions, including this extension.',
		['contentSettings'],
		[],
	],
	[
		'Access document scanners attached via USB or on the local network',
		['documentScan'],
		[],
	],
	['Read and change anything you type', ['input'], []],
	['Manage your apps, extensions, and themes', ['management'], []],
	['Discover devices on your local network, like printers', ['mdns'], []],
	['Communicate with cooperating native applications', ['nativeMessaging'], []],
	['Change your privacy-related settings', ['privacy'], []],
	['Store data in your Google Drive account', ['syncFileSystem'], []],
	['View and manage your tab groups', ['tabGroups'], []],
	['Read all text spoken using synthesized speech', ['ttsEngine'], []],
	['Change your wallpaper', ['wallpaper'], []],
	['Use your client certificates', ['platformKeys'], []],
	['Provide certificates for authentication', ['certificateProvider'], []],
	[
		'Read the manufacturer and model of this computer',
		['enterpriseHardwarePlatform'],
		[],
	],
	[
		'See device information, such as its serial number or asset ID',
		['enterpriseDeviceAttributes'],
		[],
	],
	[
		'See which sites you call from and when your camera or microphone is used',
		['enterpriseWebrtc'],
		[],
	],
	['Change the system keyboard layout', ['enterpriseKioskInput'], []],
	['Exit managed guest sessions', ['enterpriseLogin'], []],
	[
		'See network information, such as your IP or MAC address',
		['enterpriseNetworkingAttributes'],
		[],
	],
	[
		'Perform security-related tasks for your organization, such as managing certificates and keys stored on the device',
		['enterprisePlatformKeys'],
		[],
	],
	[
		'Read and save keyboard input from the address bar',
		['omniboxDirectInput'],
		[],
	],
	[
		'Run in the background when requested by a cooperating native application',
		['transientBackground'],
		[],
	],
];

/** what a manifest's match pattern names: its scheme and host (`*.x` for x and its subdomains), or every host */
function patternHost(
	pattern: string,
): { all: true } | { scheme: string; host: string } | null {
	if (pattern === '<all_urls>') return { all: true };
	const parts = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(pattern);
	if (!parts) return null;
	const scheme = parts[1].toLowerCase();
	// (a host with a port: the port says nothing here)
	const host = parts[2].replace(/:(\*|\d+)$/, '').toLowerCase();
	if (scheme === 'file') return { scheme, host: '' };
	if (host === '*' || (host === '' && scheme !== 'chrome'))
		return { all: true };
	return { scheme, host };
}

/** RcdBetterThan: com, then net, then org */
function betterRegistry(a: string, b: string): boolean {
	if (a === b) return false;
	if (a === 'com') return true;
	if (a === 'net') return b !== 'com';
	if (a === 'org') return b !== 'com' && b !== 'net';
	return false;
}

/**
 * The warnings of a manifest. `registry(host)` is the host's ICANN public
 * suffix ('' when it has none), which joins google.com and google.de into
 * one site as Chrome does and tells `*.co.uk` reaches every site
 */
export function permissionMessages(
	manifest: Record<string, unknown>,
	registry: (host: string) => string,
): PermissionMessage[] {
	const ids = new Set<string>();
	const patterns: string[] = [];
	const mv3 = Number(manifest.manifest_version) >= 3;
	const strings = (value: unknown) =>
		Array.isArray(value)
			? value.filter((item): item is string => typeof item === 'string')
			: [];
	for (const permission of strings(manifest.permissions)) {
		if (permission.includes('://') || permission === '<all_urls>') {
			// (an MV3 manifest's hosts go in host_permissions; Chrome drops
			// the ones in permissions)
			if (!mv3) patterns.push(permission);
			continue;
		}
		if (FULL_URL_ACCESS.has(permission)) ids.add('hostsAll');
		const id = IDS[permission];
		if (id) ids.add(id);
	}
	patterns.push(...strings(manifest.host_permissions));
	const scripts = Array.isArray(manifest.content_scripts)
		? (manifest.content_scripts as { matches?: unknown }[])
		: [];
	for (const script of scripts) patterns.push(...strings(script?.matches));
	if (typeof manifest.devtools_page === 'string') ids.add('hostsAll');
	const overrides = manifest.chrome_url_overrides as
		Record<string, unknown> | undefined;
	if (overrides && typeof overrides.newtab === 'string') ids.add('newTabPage');
	// chrome_settings_overrides: the page or the search engine's host
	const settings = manifest.chrome_settings_overrides as
		Record<string, unknown> | undefined;
	const settingHost = (value: unknown) => {
		try {
			return new URL(String(value)).host;
		} catch (error) {
			return String(value);
		}
	};
	const parameters = new Map<string, string>();
	if (settings?.homepage) {
		ids.add('homepage');
		parameters.set('homepage', settingHost(settings.homepage));
	}
	const search = settings?.search_provider as
		Record<string, unknown> | undefined;
	if (search?.search_url) {
		ids.add('searchProvider');
		parameters.set('searchProvider', settingHost(search.search_url));
	}
	const startup = strings(settings?.startup_pages);
	if (startup.length) {
		ids.add('startupPages');
		parameters.set('startupPages', settingHost(startup[0]));
	}

	// the sites (GetDistinctHosts with the registry kept): a host and its
	// best registry, `*.` for a pattern of its subdomains
	const hosts: [string, string][] = [];
	for (const pattern of patterns) {
		const parsed = patternHost(pattern);
		if (!parsed) continue;
		if ('all' in parsed) {
			ids.add('hostsAll');
			continue;
		}
		if (parsed.scheme === 'file') continue;
		if (parsed.scheme === 'chrome') {
			if (parsed.host === 'favicon') ids.add('favicon');
			continue;
		}
		let host = parsed.host;
		const wildcard = host.startsWith('*.');
		const bare = wildcard ? host.slice(2) : host;
		const suffix = registry(bare);
		// a pattern of every name under a public suffix (*.com) reaches every site
		if (wildcard && suffix && suffix === bare) {
			ids.add('hostsAll');
			continue;
		}
		let rcd = '';
		if (suffix && bare.length > suffix.length) {
			rcd = suffix;
			host = host.slice(0, host.length - suffix.length);
		}
		const seen = hosts.find(([name]) => name === host);
		if (seen) {
			if (betterRegistry(rcd, seen[1])) seen[1] = rcd;
		} else hosts.push([host, rcd]);
	}
	const sites = [...new Set(hosts.map(([name, rcd]) => name + rcd))].sort();
	if (sites.length) ids.add('host');

	const messages: PermissionMessage[] = [];
	for (const [message, required, absorbed] of RULES) {
		if (!required.every((id) => ids.has(id))) continue;
		for (const id of [...required, ...absorbed]) ids.delete(id);
		if (message === 'hosts') messages.push(hostsMessage(sites));
		else if (message === 'homepage')
			messages.push({
				message: `Change your home page to: ${parameters.get('homepage')}`,
				details: [],
			});
		else if (message === 'searchProvider')
			messages.push({
				message: `Change your search settings to: ${parameters.get('searchProvider')}`,
				details: [],
			});
		else if (message === 'startupPages')
			messages.push({
				message: `Change your start page to: ${parameters.get('startupPages')}`,
				details: [],
			});
		else messages.push({ message, details: [] });
	}
	return messages;
}

/** HostListFormatter: up to three sites in the line, more below a line of their own */
function hostsMessage(sites: string[]): PermissionMessage {
	const inline = sites.length <= 3;
	const named = sites.map((site) =>
		site.startsWith('*.')
			? `${inline ? 'all' : 'All'} ${site.slice(2)} sites`
			: site,
	);
	if (named.length === 1)
		return { message: `Read and change your data on ${named[0]}`, details: [] };
	if (named.length === 2)
		return {
			message: `Read and change your data on ${named[0]} and ${named[1]}`,
			details: [],
		};
	if (named.length === 3)
		return {
			message: `Read and change your data on ${named[0]}, ${named[1]}, and ${named[2]}`,
			details: [],
		};
	return {
		message: 'Read and change your data on a number of websites',
		details: named,
	};
}
