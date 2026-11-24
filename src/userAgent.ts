export interface UserAgentBrand {
	brand: string;
	version: string;
}

/** One coherent Chrome identity for JavaScript and the network stack. */
export interface UserAgentIdentity {
	userAgent: string;
	appVersion: string;
	major: string;
	fullVersion: string;
	platform: string;
	mobile: boolean;
	brands: UserAgentBrand[];
	fullVersionList: UserAgentBrand[];
	uaPlatform: 'Linux' | 'Android';
	platformVersion: string;
	architecture: string;
	bitness: string;
	model: string;
	wow64: false;
	formFactors: ['Desktop' | 'Mobile'];
}

/**
 * Resolve the configured Chrome UA without consulting the host browser. An
 * Android UA selects Chrome for Android; every other Chrome UA selects the
 * Linux desktop identity. The model is deliberately unknown, never the host's.
 */
export function userAgentIdentity(userAgent: string): UserAgentIdentity {
	const match = /Chrome\/(\d+(?:\.\d+){3})/.exec(userAgent);
	if (!match)
		throw new TypeError(
			'Stomp userAgent must contain Chrome/<full version>, for example Chrome/158.0.0.0',
		);
	const fullVersion = match[1];
	const major = fullVersion.split('.')[0];
	const mobile = /\bAndroid\b/.test(userAgent);
	const brands = [
		{ brand: 'Not/A)Brand', version: '8' },
		{ brand: 'Chromium', version: major },
		{ brand: 'Google Chrome', version: major },
	];
	return {
		userAgent,
		appVersion: userAgent.slice(userAgent.indexOf('/') + 1),
		major,
		fullVersion,
		platform: mobile ? 'Linux armv8l' : 'Linux x86_64',
		mobile,
		brands,
		fullVersionList: brands.map(({ brand }) => ({
			brand,
			version: brand === 'Not/A)Brand' ? '8.0.0.0' : fullVersion,
		})),
		uaPlatform: mobile ? 'Android' : 'Linux',
		platformVersion: mobile ? '10.0.0' : '',
		architecture: mobile ? '' : 'x86',
		bitness: mobile ? '' : '64',
		model: '',
		wow64: false,
		formFactors: [mobile ? 'Mobile' : 'Desktop'],
	};
}
