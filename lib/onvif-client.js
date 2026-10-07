'use strict';

// Thin wrapper around the `onvif` npm package for the operations we care about:
//   - Motion event subscription (pull-point or basic notifications)
//   - PTZ relative move
//
// The `onvif` library covers ONVIF Profile S/T. DCS-8000LHV2 implements ONVIF S
// per D-Link spec, so PTZ + RuleEngine motion events should be available.

const { Cam, Discovery } = require('onvif');

// ONVIF WS-Discovery: probe network for ONVIF devices. Works on the local
// broadcast domain. For VLAN-separated networks the user has to enter IP
// manually (network-wide unicast scan is impractical for ONVIF).
function discoverCameras({ timeoutMs = 4000 } = {}) {
	return new Promise((resolve) => {
		const found = new Map();
		const onDevice = (cam) => {
			// cam.urn is unique per device. Pull IP/port out of the discovery XAddr.
			const xaddr = (cam.xaddrs && cam.xaddrs[0]) || '';
			const match = xaddr.match(/^https?:\/\/([^:/]+)(?::(\d+))?/);
			if (!match) return;
			const ip = match[1];
			const port = parseInt(match[2] || '80', 10);
			const key = `${ip}:${port}`;
			if (found.has(key)) return;
			found.set(key, { ip, port, urn: cam.urn, name: cam.name || null, scopes: cam.scopes || [] });
		};
		try {
			Discovery.on('device', onDevice);
			Discovery.probe({ timeout: timeoutMs, resolve: false }, () => {
				Discovery.removeListener('device', onDevice);
				resolve(Array.from(found.values()));
			});
		} catch (e) {
			Discovery.removeListener('device', onDevice);
			resolve([]);
		}
	});
}


class OnvifClient {

	constructor({ ip, port = 80, user, pwd, log = () => {} }) {
		this.ip = ip;
		this.port = port;
		this.user = user;
		this.pwd = pwd;
		this.log = log;
		this.cam = null;
		this._pullStop = null;
	}

	connect() {
		return new Promise((resolve, reject) => {
			this.cam = new Cam({
				hostname: this.ip,
				port: this.port,
				username: this.user,
				password: this.pwd,
				timeout: 8000,
			}, (err) => {
				if (err) return reject(err);
				resolve();
			});
		});
	}

	// Subscribe to motion events using ONVIF pull-point.
	// onMotion(active: bool) is called when the motion state changes.
	subscribeMotion(onMotion) {
		if (!this.cam) throw new Error('connect() first');
		return new Promise((resolve, reject) => {
			this.cam.createPullPointSubscription((err, sub) => {
				if (err) return reject(err);
				let active = false;
				let stopped = false;

				const pull = () => {
					if (stopped) return;
					this.cam.pullMessages({ timeout: 'PT30S', messageLimit: 8 }, (e, msg) => {
						if (stopped) return;
						if (e) {
							this.log(`pullMessages error: ${e.message}`);
							// brief backoff
							setTimeout(pull, 5000);
							return;
						}
						const items = []
							.concat(msg && msg.notificationMessage ? msg.notificationMessage : [])
							.filter(Boolean);
						for (const n of items) {
							if (isMotionTopic(n)) {
								const isActive = extractMotionState(n);
								if (isActive !== null && isActive !== active) {
									active = isActive;
									try { onMotion(active); } catch (cb) { this.log(`onMotion cb threw: ${cb.message}`); }
								}
							}
						}
						setImmediate(pull);
					});
				};

				this._pullStop = () => { stopped = true; };
				pull();
				resolve();
			});
		});
	}

	stopMotion() {
		if (this._pullStop) {
			this._pullStop();
			this._pullStop = null;
		}
	}

	// PTZ relative move: dir = 'up'|'down'|'left'|'right'|'home'
	ptz(dir, magnitude = 0.3) {
		if (!this.cam) throw new Error('connect() first');
		const m = Math.max(0, Math.min(1, magnitude));
		const map = {
			up:    { x: 0,  y:  m, zoom: 0 },
			down:  { x: 0,  y: -m, zoom: 0 },
			left:  { x: -m, y:  0, zoom: 0 },
			right: { x:  m, y:  0, zoom: 0 },
		};

		if (dir === 'home') {
			return new Promise((resolve, reject) => {
				this.cam.gotoHomePosition({}, (err) => err ? reject(err) : resolve());
			});
		}
		const v = map[dir];
		if (!v) return Promise.reject(new Error(`unknown ptz direction: ${dir}`));
		return new Promise((resolve, reject) => {
			this.cam.relativeMove(v, (err) => err ? reject(err) : resolve());
		});
	}

}

function isMotionTopic(n) {
	const topic = n && n.topic && n.topic._;
	if (!topic) return false;
	// Common ONVIF motion topics:
	//   tns1:RuleEngine/CellMotionDetector/Motion
	//   tns1:VideoSource/MotionAlarm
	return /Motion/i.test(topic);
}

function extractMotionState(n) {
	try {
		const data = n.message && n.message.message && n.message.message.data;
		if (!data) return null;
		const items = Array.isArray(data.simpleItem) ? data.simpleItem : [data.simpleItem].filter(Boolean);
		for (const item of items) {
			const v = item && item.$ && item.$.Value;
			if (typeof v === 'string') {
				if (v === 'true' || v === '1') return true;
				if (v === 'false' || v === '0') return false;
			}
			if (typeof v === 'boolean') return v;
		}
	} catch (_) { /* ignore parsing weirdness */ }
	return null;
}

module.exports = { OnvifClient, discoverCameras };
