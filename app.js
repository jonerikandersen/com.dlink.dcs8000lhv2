'use strict';

const Homey = require('homey');

// Homey offers no way to read an installed app's stdout, so the last lines of
// the log are also kept in the app setting "diag" (read it with
// `homey api apps get-app-setting --id com.dlink.dcs8000lhv2 --name diag`).
const DIAG_LINES = 80;

class DlinkCameraApp extends Homey.App {

	async onInit() {
		this._diag = this.homey.settings.get('diag') || [];
		this.diag(`${this.homey.manifest.id} v${this.homey.manifest.version} starting`);
	}

	diag(...args) {
		const line = `${new Date().toISOString()} ${args.map(String).join(' ')}`;
		this.log(line);
		this._diag.push(line);
		if (this._diag.length > DIAG_LINES) this._diag.splice(0, this._diag.length - DIAG_LINES);
		// Persist at most every 10 s, so a burst of camera events does not mean a burst of writes.
		if (this._diagTimer) return;
		this._diagTimer = this.homey.setTimeout(() => {
			this._diagTimer = null;
			this.homey.settings.set('diag', this._diag);
		}, 10000);
	}

}

module.exports = DlinkCameraApp;
