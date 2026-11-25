'use strict';

// ONVIF pull-point event client for DCS-8000LHV2.
//
// Why not the `onvif` npm package: the camera rejects every event request that
// lacks WS-Addressing headers (Action, MessageID, To), and the package does not
// send them. The camera also answers a bodiless POST with 500 instead of 401, so
// the Digest challenge has to come from a request that carries the full SOAP body.
//
// Verified on firmware 1.05.03: one topic, "Event", with a string data item
// named "Event". The payload for motion has not been observed yet, so every
// notification is passed on and the caller decides what counts as motion.

const crypto = require('crypto');
const { request, parseDigestChallenge, buildDigestHeader } = require('./snapshot');

const EV = 'http://www.onvif.org/ver10/events/wsdl';
const TERMINATION = 'PT300S';
const RENEW_AFTER_MS = 240 * 1000; // resubscribe before the 300 s termination time
const PULL_TIMEOUT = 'PT20S';

function soapEnvelope(action, to, body) {
	return '<?xml version="1.0" encoding="UTF-8"?>'
		+ '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing">'
		+ '<s:Header>'
		+ `<a:Action s:mustUnderstand="1">${action}</a:Action>`
		+ `<a:MessageID>urn:uuid:${crypto.randomUUID()}</a:MessageID>`
		+ '<a:ReplyTo><a:Address>http://www.w3.org/2005/08/addressing/anonymous</a:Address></a:ReplyTo>'
		+ `<a:To s:mustUnderstand="1">${to}</a:To>`
		+ '</s:Header>'
		+ `<s:Body>${body}</s:Body></s:Envelope>`;
}

// Drop namespace prefixes so the regexes below can stay simple.
function stripPrefixes(xml) {
	return xml.replace(/<(\/?)[\w-]+:/g, '<$1').replace(/\s(?:[\w-]+:)?([\w-]+)=/g, ' $1=');
}

function soapFault(xml) {
	const m = stripPrefixes(xml).match(/<Reason>\s*<Text[^>]*>([^<]*)/);
	return m ? m[1].trim() : null;
}

// Parse PullMessagesResponse into [{ topic, source: {k: v}, data: {k: v} }].
function parseNotifications(xml) {
	const s = stripPrefixes(xml);
	return s.split('<NotificationMessage>').slice(1).map((chunk) => {
		const topic = ((chunk.match(/<Topic[^>]*>([^<]+)<\/Topic>/) || [])[1] || '').trim();
		const items = (section) => {
			const out = {};
			const part = (chunk.match(new RegExp(`<${section}>([\\s\\S]*?)</${section}>`)) || [])[1] || '';
			part.replace(/<SimpleItem\b[^>]*?Name="([^"]*)"[^>]*?Value="([^"]*)"/g, (_, k, v) => { out[k] = v; });
			return out;
		};
		return { topic, source: items('Source'), data: items('Data') };
	});
}

class OnvifEvents {

	constructor({ ip, port = 80, user = 'admin', pwd, log = () => {} }) {
		this.ip = ip;
		this.port = port;
		this.user = user;
		this.pwd = pwd;
		this.log = log;
		this._running = false;
		this._address = null;
		this._subscribedAt = 0;
		this._nc = 0;
	}

	async _soap(url, action, body, timeoutMs = 10000) {
		const { pathname } = new URL(url);
		const envelope = soapEnvelope(action, url, body);
		const headers = {
			'Content-Type': 'application/soap+xml; charset=utf-8',
			'Content-Length': Buffer.byteLength(envelope),
		};
		const opts = { host: this.ip, port: this.port, path: pathname, method: 'POST', timeoutMs, body: envelope };
		let res = await request({ ...opts, headers });
		if (res.statusCode === 401) {
			const challenge = parseDigestChallenge(res.headers['www-authenticate']);
			if (!challenge) throw new Error('401 without a Digest challenge');
			const nc = String(++this._nc).padStart(8, '0');
			const auth = buildDigestHeader({ user: this.user, pwd: this.pwd, method: 'POST', uri: pathname, challenge, nc });
			res = await request({ ...opts, headers: { ...headers, Authorization: auth } });
			if (res.statusCode === 401) throw new Error('401 after digest: wrong PIN');
		}
		const text = res.body.toString('utf8');
		if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}${soapFault(text) ? `: ${soapFault(text)}` : ''}`);
		return text;
	}

	async _subscribe() {
		// The camera matches the WS-Addressing To header literally: no ":80".
		const host = Number(this.port) === 80 ? this.ip : `${this.ip}:${this.port}`;
		const url = `http://${host}/onvif/event_service`;
		const xml = await this._soap(url, `${EV}/EventPortType/CreatePullPointSubscriptionRequest`,
			`<CreatePullPointSubscription xmlns="${EV}"><InitialTerminationTime>${TERMINATION}</InitialTerminationTime></CreatePullPointSubscription>`);
		const address = (stripPrefixes(xml).match(/<SubscriptionReference>\s*<Address>([^<]+)<\/Address>/) || [])[1];
		if (!address) throw new Error('no subscription address in response');
		this._address = address.trim();
		this._subscribedAt = Date.now();
	}

	async _unsubscribe() {
		if (!this._address) return;
		const address = this._address;
		this._address = null;
		await this._soap(address, 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeRequest',
			'<Unsubscribe xmlns="http://docs.oasis-open.org/wsn/b-2"/>').catch(() => {});
	}

	// Check that the event service answers with these credentials.
	async probe() {
		await this._subscribe();
		await this._unsubscribe();
	}

	// Start the pull loop. onEvent({ topic, source, data }) is called per notification.
	// onState(connected: bool, error?: Error) reports connectivity changes.
	start(onEvent, onState = () => {}) {
		if (this._running) return;
		this._running = true;
		let connected = null;
		let backoff = 5000;
		const setState = (ok, err) => {
			if (ok === connected) return;
			connected = ok;
			try { onState(ok, err); } catch (_) { /* ignore */ }
		};

		const loop = async () => {
			while (this._running) {
				try {
					if (!this._address || Date.now() - this._subscribedAt > RENEW_AFTER_MS) {
						await this._unsubscribe();
						await this._subscribe();
					}
					const xml = await this._soap(this._address, `${EV}/PullPointSubscription/PullMessagesRequest`,
						`<PullMessages xmlns="${EV}"><Timeout>${PULL_TIMEOUT}</Timeout><MessageLimit>20</MessageLimit></PullMessages>`,
						40000);
					setState(true);
					backoff = 5000;
					for (const n of parseNotifications(xml)) {
						try { onEvent(n); } catch (e) { this.log(`event handler threw: ${e.message}`); }
					}
				} catch (e) {
					if (!this._running) break;
					this.log(`ONVIF events: ${e.message}; retrying in ${backoff / 1000}s`);
					setState(false, e);
					this._address = null;
					await new Promise((r) => setTimeout(r, backoff));
					backoff = Math.min(backoff * 2, 120000);
				}
			}
		};
		this._loop = loop();
	}

	async stop() {
		this._running = false;
		await this._unsubscribe();
	}

}

module.exports = { OnvifEvents, parseNotifications };
