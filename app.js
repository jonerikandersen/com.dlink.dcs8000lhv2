'use strict';

const Homey = require('homey');

class DlinkCameraApp extends Homey.App {

	async onInit() {
		this.log(`${this.homey.manifest.id} v${this.homey.manifest.version} starting`);
	}

}

module.exports = DlinkCameraApp;
