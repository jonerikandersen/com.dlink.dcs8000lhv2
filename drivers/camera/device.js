'use strict';

const Homey = require('homey');
const { fetchSnapshot } = require('../../lib/snapshot');
const { OnvifEvents } = require('../../lib/onvif-events');

class DlinkCameraDevice extends Homey.Device {

	// Log to stdout and to the app's "diag" setting (see app.js).
	log(...args) {
		const app = this.homey.app;
		if (app && typeof app.diag === 'function') app.diag(`[${this.getName()}]`, ...args);
		else super.log(...args);
	}

	async onInit() {
		try {
			await this._init();
		} catch (e) {
			this.log(`init failed: ${e.stack || e.message}`);
			throw e;
		}
	}

	async _init() {
		this._snapshotImage = null;
		this._video = null;
		// Not "_events": that is EventEmitter's own listener map on Homey.Device.
		this._eventClient = null;
		this._snapshotTimer = null;
		this._motionResetTimer = null;

		this._motionTrigger = this.homey.flow.getDeviceTriggerCard('motion_detected');

		await this._setupVideoStream();
		await this._setupSnapshot();
		this._startEvents();

		this.registerCapabilityListener('button_snapshot', () => this._refreshSnapshotOnce());

		this.log(`D-Link camera ready: ${this.getName()} @ ${this.getSetting('ip')}`);
	}

	async onUninit() {
		await this._teardown();
	}

	async onDeleted() {
		await this._teardown();
		if (this._video) {
			try { await this.homey.videos.unregisterVideo(this._video); } catch (_) { /* ignore */ }
			this._video = null;
		}
	}

	async _teardown() {
		this._stopSnapshot();
		this._clearMotionReset();
		if (this._eventClient) {
			const client = this._eventClient;
			this._eventClient = null;
			await client.stop().catch(() => {});
		}
	}

	async onSettings({ changedKeys }) {
		if (changedKeys.includes('snapshot_interval_s')) {
			this._stopSnapshot();
			// Wait for the new value to be stored before restarting the loop.
			this.homey.setTimeout(() => this._startSnapshotLoop(), 500);
		}
		if (changedKeys.some((k) => ['ip', 'rtsp_user', 'rtsp_password'].includes(k))) {
			this.homey.setTimeout(() => this._refreshSnapshotOnce().catch(() => {}), 500);
		}
		if (changedKeys.some((k) => ['ip', 'rtsp_user', 'rtsp_password', 'onvif_enabled'].includes(k))) {
			if (this._eventClient) {
				await this._eventClient.stop().catch(() => {});
				this._eventClient = null;
			}
			this.homey.setTimeout(() => this._startEvents(), 500);
		}
	}

	_credentials() {
		return {
			ip: this.getSetting('ip'),
			user: this.getSetting('rtsp_user') || 'admin',
			pwd: this.getSetting('rtsp_password') || '',
		};
	}

	// ---- RTSP stream ----

	async _setupVideoStream() {
		try {
			this._video = await this.homey.videos.createVideoRTSP();
			this._video.registerVideoUrlListener(async () => ({ url: this._rtspUrl() }));
			await this.setCameraVideo('rtsp', 'Live', this._video);
		} catch (e) {
			this.log(`Failed to set up RTSP video: ${e.message}`);
		}
	}

	_rtspUrl() {
		const { ip, user, pwd } = this._credentials();
		const profile = this.getSetting('profile') || 'profile.0';
		return `rtsp://${encodeURIComponent(user)}:${encodeURIComponent(pwd)}@${ip}:554/live/${profile}`;
	}

	// ---- snapshot image ----

	async _setupSnapshot() {
		try {
			this._snapshotImage = await this.homey.images.createImage();
			this._snapshotImage.setStream(async (stream) => stream.end(await fetchSnapshot(this._credentials())));
			await this.setCameraImage('snapshot', 'Latest snapshot', this._snapshotImage);
		} catch (e) {
			this.log(`Failed to set up snapshot image: ${e.message}`);
		}
		this._startSnapshotLoop();
	}

	_startSnapshotLoop() {
		if (this._snapshotTimer) return;
		const interval = Math.max(5, this.getSetting('snapshot_interval_s') || 30) * 1000;
		this._snapshotTimer = this.homey.setInterval(() => this._refreshSnapshotOnce().catch(() => {}), interval);
		this.homey.setTimeout(() => this._refreshSnapshotOnce().catch(() => {}), 1500);
	}

	_stopSnapshot() {
		if (this._snapshotTimer) {
			this.homey.clearInterval(this._snapshotTimer);
			this._snapshotTimer = null;
		}
	}

	async _refreshSnapshotOnce() {
		if (!this._snapshotImage) return;
		try {
			await this._snapshotImage.update();
			if (!this.getAvailable()) await this.setAvailable();
		} catch (e) {
			this.log(`snapshot refresh failed: ${e.message}`);
			await this.setUnavailable(`Snapshot failed: ${e.message}`).catch(() => {});
		}
	}

	// Used by the flow action 'take_snapshot': a fresh image token.
	async takeSnapshot() {
		const img = await this.homey.images.createImage();
		const buf = await fetchSnapshot(this._credentials());
		img.setStream(async (stream) => stream.end(buf));
		await img.update();
		return img;
	}

	// ---- motion via ONVIF events ----

	_startEvents() {
		if (this._eventClient || !this.getSetting('onvif_enabled')) return;
		const { ip, user, pwd } = this._credentials();
		if (!ip || !pwd) return;
		this._eventClient = new OnvifEvents({ ip, user, pwd, log: (...a) => this.log(...a) });
		this._eventClient.start(
			(n) => this._onCameraEvent(n),
			(ok, err) => this.log(ok ? 'ONVIF events connected' : `ONVIF events lost: ${err ? err.message : 'unknown'}`),
		);
	}

	// The camera has a single topic ("Event") with a string item "Event". Until a
	// motion payload has been seen on the real camera, anything mentioning motion
	// counts, explicit false values end it, and every event is logged.
	_onCameraEvent({ topic, source, data }) {
		this.log(`camera event: ${topic} source=${JSON.stringify(source)} data=${JSON.stringify(data)}`);
		const values = Object.values(data).map((v) => String(v));
		const text = `${topic} ${values.join(' ')}`;
		if (!/motion/i.test(text)) return;
		const off = values.some((v) => /^(false|0|off|stop|end)$/i.test(v));
		this._setMotion(!off);
	}

	async _setMotion(active) {
		this._clearMotionReset();
		const wasActive = this.getCapabilityValue('alarm_motion') === true;
		await this.setCapabilityValue('alarm_motion', active).catch((e) => this.log(`alarm_motion: ${e.message}`));
		if (!active) return;
		if (!wasActive) {
			await this._motionTrigger.trigger(this, {}, {}).catch((e) => this.log(`motion trigger: ${e.message}`));
		}
		// The camera may never send an explicit "motion ended", so reset after a while.
		const resetS = Math.max(5, this.getSetting('motion_reset_s') || 30);
		this._motionResetTimer = this.homey.setTimeout(() => {
			this._motionResetTimer = null;
			this.setCapabilityValue('alarm_motion', false).catch(() => {});
		}, resetS * 1000);
	}

	_clearMotionReset() {
		if (this._motionResetTimer) {
			this.homey.clearTimeout(this._motionResetTimer);
			this._motionResetTimer = null;
		}
	}

}

module.exports = DlinkCameraDevice;
