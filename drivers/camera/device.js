'use strict';

const Homey = require('homey');
const { fetchSnapshot } = require('../../lib/snapshot');
const { OnvifClient } = require('../../lib/onvif-client');

class DlinkCameraDevice extends Homey.Device {

	async onInit() {
		this._snapshotImage = null;
		this._video = null;
		this._onvif = null;
		this._snapshotTimer = null;

		await this._setupVideoStream();
		await this._setupSnapshot();
		await this._setupOnvif();

		this._motionTrigger = this.homey.flow.getTriggerCard('motion_detected');

		// PTZ buttons on the device tile
		this.registerCapabilityListener('button_up',       () => this._safePtz('up'));
		this.registerCapabilityListener('button_down',     () => this._safePtz('down'));
		this.registerCapabilityListener('button_left',     () => this._safePtz('left'));
		this.registerCapabilityListener('button_right',    () => this._safePtz('right'));
		this.registerCapabilityListener('button_home',     () => this._safePtz('home'));
		this.registerCapabilityListener('button_snapshot', () => this._refreshSnapshotOnce());

		this.log(`D-Link camera ready: ${this.getName()} @ ${this.getSetting('ip')}`);
	}

	async _safePtz(dir) {
		try {
			await this.ptz(dir);
		} catch (e) {
			this.log(`PTZ ${dir} failed: ${e.message}`);
			throw new Error(e.message);
		}
	}

	async onDeleted() {
		this._stopSnapshot();
		if (this._onvif) {
			this._onvif.stopMotion();
			this._onvif = null;
		}
		if (this._video) {
			try { await this.homey.videos.unregisterVideo(this._video); } catch (_) { /* ignore */ }
			this._video = null;
		}
	}

	async onSettings({ changedKeys }) {
		if (changedKeys.includes('snapshot_interval_s')) {
			this._stopSnapshot();
			this._startSnapshotLoop();
		}
		if (changedKeys.some((k) => ['ip', 'rtsp_user', 'rtsp_password', 'profile'].includes(k))) {
			// Video URL listener reads settings live, so just trigger a refresh
			// by registering a new image too.
			await this._refreshSnapshotOnce().catch(() => {});
		}
		if (changedKeys.some((k) => ['ip', 'rtsp_user', 'rtsp_password', 'onvif_port', 'onvif_enabled'].includes(k))) {
			if (this._onvif) this._onvif.stopMotion();
			this._onvif = null;
			await this._setupOnvif();
		}
	}

	// ---- RTSP stream ----

	async _setupVideoStream() {
		try {
			this._video = await this.homey.videos.createVideoRTSP();
			this._video.registerVideoUrlListener(async () => {
				return { url: this._rtspUrl() };
			});
			await this.setCameraVideo('rtsp', 'Live stream', this._video);
		} catch (e) {
			this.log(`Failed to set up RTSP video: ${e.message}`);
		}
	}

	_rtspUrl() {
		const ip = this.getSetting('ip');
		const user = encodeURIComponent(this.getSetting('rtsp_user') || 'admin');
		const pwd = encodeURIComponent(this.getSetting('rtsp_password') || '');
		const profile = this.getSetting('profile') || 'profile.0';
		return `rtsp://${user}:${pwd}@${ip}:554/live/${profile}`;
	}

	// ---- snapshot image ----

	async _setupSnapshot() {
		try {
			this._snapshotImage = await this.homey.images.createImage();
			this._snapshotImage.setStream(async (stream) => {
				const buf = await fetchSnapshot({
					ip: this.getSetting('ip'),
					user: this.getSetting('rtsp_user') || 'admin',
					pwd: this.getSetting('rtsp_password') || '',
				});
				stream.end(buf);
			});
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
		// fire once immediately so the device gets a thumbnail right away
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

	async takeSnapshot() {
		// Used by flow action 'take_snapshot' — returns a fresh Image token
		const img = await this.homey.images.createImage();
		img.setStream(async (stream) => {
			const buf = await fetchSnapshot({
				ip: this.getSetting('ip'),
				user: this.getSetting('rtsp_user') || 'admin',
				pwd: this.getSetting('rtsp_password') || '',
			});
			stream.end(buf);
		});
		await img.update();
		return img;
	}

	// ---- ONVIF (motion + PTZ) ----

	async _setupOnvif() {
		if (!this.getSetting('onvif_enabled')) return;
		const client = new OnvifClient({
			ip:   this.getSetting('ip'),
			port: this.getSetting('onvif_port') || 80,
			user: this.getSetting('rtsp_user') || 'admin',
			pwd:  this.getSetting('rtsp_password') || '',
			log:  (...a) => this.log(...a),
		});
		try {
			await client.connect();
		} catch (e) {
			this.log(`ONVIF connect failed: ${e.message} — motion + PTZ disabled`);
			return;
		}

		this._onvif = client;

		try {
			await client.subscribeMotion(async (active) => {
				try {
					await this.setCapabilityValue('alarm_motion', !!active);
					if (active && this._motionTrigger) {
						await this._motionTrigger.trigger(this, {}, {}).catch((e) => this.log(`motion trigger: ${e.message}`));
					}
				} catch (e) {
					this.log(`motion handler: ${e.message}`);
				}
			});
			this.log('ONVIF motion subscription active');
		} catch (e) {
			this.log(`ONVIF motion subscribe failed: ${e.message}`);
		}
	}

	async ptz(direction) {
		if (!this._onvif) throw new Error('ONVIF not connected — PTZ unavailable');
		return this._onvif.ptz(direction);
	}

}

module.exports = DlinkCameraDevice;
