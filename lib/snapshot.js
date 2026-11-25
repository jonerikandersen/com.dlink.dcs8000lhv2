'use strict';

// HTTP snapshot fetcher for DCS-8000LHV2.
// The camera serves a JPEG at /image/jpeg.cgi behind HTTP Digest auth.
// Verified on firmware 1.05.03: GET returns 1280x720 baseline JPEG (~80 KB).

const http = require('http');
const crypto = require('crypto');

const DEFAULT_PATH = '/image/jpeg.cgi';

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

// Parse a WWW-Authenticate Digest header into a key/value map.
function parseDigestChallenge(header) {
	if (!header || !/^Digest/i.test(header)) return null;
	const out = {};
	const body = header.replace(/^Digest\s+/i, '');
	// Split on commas not inside quotes
	const parts = [];
	let buf = '';
	let inQuote = false;
	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		if (c === '"') inQuote = !inQuote;
		if (c === ',' && !inQuote) { parts.push(buf); buf = ''; continue; }
		buf += c;
	}
	if (buf) parts.push(buf);

	for (const part of parts) {
		const m = part.trim().match(/^(\w+)\s*=\s*(?:"([^"]*)"|(\S*))$/);
		if (m) out[m[1]] = m[2] !== undefined ? m[2] : m[3];
	}
	return out;
}

function buildDigestHeader({ user, pwd, method, uri, challenge, nc = '00000001' }) {
	const cnonce = crypto.randomBytes(8).toString('hex');
	const qop = challenge.qop ? challenge.qop.split(',')[0].trim() : null;
	const ha1 = md5(`${user}:${challenge.realm}:${pwd}`);
	const ha2 = md5(`${method}:${uri}`);
	const response = qop
		? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
		: md5(`${ha1}:${challenge.nonce}:${ha2}`);

	const parts = [
		`username="${user}"`,
		`realm="${challenge.realm}"`,
		`nonce="${challenge.nonce}"`,
		`uri="${uri}"`,
		`response="${response}"`,
	];
	if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);
	if (qop) {
		parts.push(`qop=${qop}`);
		parts.push(`nc=${nc}`);
		parts.push(`cnonce="${cnonce}"`);
	}
	if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
	return 'Digest ' + parts.join(', ');
}

function request({ host, port, path, method, headers, timeoutMs, body }) {
	return new Promise((resolve, reject) => {
		const opts = { host, port, path, method, headers, timeout: timeoutMs };
		const req = http.request(opts, (res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => resolve({
				statusCode: res.statusCode,
				headers: res.headers,
				body: Buffer.concat(chunks),
			}));
			res.on('error', reject);
		});
		req.on('timeout', () => req.destroy(new Error(`timeout (${timeoutMs}ms)`)));
		req.on('error', reject);
		req.end(body);
	});
}

// Fetch a snapshot. Tries unauthenticated first; if the server returns 401 with
// a Digest challenge, retries with proper Digest authorization.
async function fetchSnapshot({ ip, user = 'admin', pwd, port = 80, path = DEFAULT_PATH, timeoutMs = 8000 }) {
	if (!pwd) throw new Error('Snapshot password (RTSP/PIN) is required');

	const first = await request({ host: ip, port, path, method: 'GET', headers: { 'User-Agent': 'homey-dlink/0.2' }, timeoutMs });

	if (first.statusCode === 200) return first.body;

	if (first.statusCode === 401) {
		const challenge = parseDigestChallenge(first.headers['www-authenticate']);
		if (!challenge) {
			throw new Error('401 returned but no Digest challenge in WWW-Authenticate header');
		}
		const auth = buildDigestHeader({ user, pwd, method: 'GET', uri: path, challenge });
		const second = await request({
			host: ip, port, path, method: 'GET',
			headers: { 'User-Agent': 'homey-dlink/0.2', Authorization: auth },
			timeoutMs,
		});
		if (second.statusCode === 200) return second.body;
		if (second.statusCode === 401) throw new Error('401 after digest — wrong username or password');
		throw new Error(`Camera returned HTTP ${second.statusCode} after digest auth`);
	}

	if (first.statusCode === 404) {
		throw new Error(`404 at ${path} — snapshot endpoint may differ on your firmware`);
	}
	throw new Error(`Camera returned HTTP ${first.statusCode}`);
}

module.exports = { fetchSnapshot, request, parseDigestChallenge, buildDigestHeader };
