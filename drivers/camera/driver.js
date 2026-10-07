'use strict';

const Homey = require('homey');
const { fetchSnapshot } = require('../../lib/snapshot');

class DlinkCameraDriver extends Homey.Driver {

	async onInit() {
		this.log('D-Link camera driver initialized');

		this.homey.flow.getActionCard('ptz_move')
			.registerRunListener(async ({ device, direction }) => device.ptz(direction));

		this.homey.flow.getActionCard('take_snapshot')
			.registerRunListener(async ({ device }) => {
				const img = await device.takeSnapshot();
				return { image: img };
			});
	}

	onPair(session) {
		const state = { ip: null, user: 'admin', pwd: null, profile: 'profile.0', snapshotBase64: null };

		session.setHandler('test', async ({ ip, user, pwd, profile }) => {
			ip = (ip || '').trim();
			user = (user || 'admin').trim();
			pwd = (pwd || '').trim();
			if (!ipLooksValid(ip)) throw new Error('Invalid IP address');
			if (!pwd) throw new Error('PIN is required');

			let buf;
			try {
				buf = await fetchSnapshot({ ip, user, pwd });
			} catch (e) {
				throw new Error(`Could not reach camera: ${e.message}`);
			}

			state.ip = ip;
			state.user = user;
			state.pwd = pwd;
			state.profile = profile || 'profile.0';
			state.snapshotBase64 = buf.toString('base64');

			return { snapshotBytes: buf.length, snapshotBase64: state.snapshotBase64 };
		});

		session.setHandler('preview', async () => ({
			ip: state.ip,
			snapshotBase64: state.snapshotBase64,
		}));

		session.setHandler('list_devices', async () => {
			if (!state.ip || !state.pwd) throw new Error('Run the connect step first');

			return [{
				name: `D-Link Camera (${state.ip})`,
				data: { id: `dlink-${state.ip}` },
				settings: {
					ip: state.ip,
					rtsp_user: state.user,
					rtsp_password: state.pwd,
					profile: state.profile,
					snapshot_interval_s: 30,
					onvif_port: 80,
					onvif_enabled: true,
				},
			}];
		});
	}

}

function ipLooksValid(ip) {
	return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every((p) => Number(p) >= 0 && Number(p) <= 255);
}

module.exports = DlinkCameraDriver;
