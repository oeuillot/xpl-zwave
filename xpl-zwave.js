"use strict";

const ZWave = require('openzwave-shared');
const Xpl = require('xpl-api');
const commander = require('commander');
const os = require('os');
const debug = require('debug')('xpl-zwave');

commander.version(require("./package.json").version);
commander.option("--zwave-logging", "Wave logging console");
commander.option("--zwave-console-output", "Console output");

commander.option("-s, --serialPort <path>", "Serial device path");
commander.option("--deviceAliases <path>", "Device aliases (path or string)");
commander.option("--emulateShutters <indexes>", "Indexes of emulated shutters");

Xpl.fillCommander(commander);

if (!commander.xplSource) {
	var hostName = os.hostname();
	if (hostName.indexOf('.') > 0) {
		hostName = hostName.substring(0, hostName.indexOf('.'));
	}

	commander.xplSource = "zwave." + hostName;
}

var emulateShutters = {};
var zwaveKeys = {};

const SHUTTER_MAX = 99;

commander.command('*').description("Start processing Zwave").action(() => {
	console.log("Starting ...");

	let deviceAliases = Xpl.loadDeviceAliases(commander.deviceAliases);

	if (commander.emulateShutters) {
		(commander.emulateShutters || '').split(',').forEach((nodeid) => {
			let da = nodeid;
			console.log("=>", nodeid, "=>", da, deviceAliases);

			emulateShutters[nodeid] = {state: undefined, target: undefined, device: da};
		});
	}

	var xpl = new Xpl(commander);

	var zwave = new ZWave({
		Logging: commander.zwaveLoggig || false,		// disable file logging (OZWLog.txt)
		ConsoleOutput: commander.zwaveConsoleOutput || false
	});

	var nodes = [];

	xpl.on("error", (error) => {
		console.error("XPL error=", error);
	});

	zwave.on('driver ready', (homeid) => {
		console.log('scanning homeid=0x%s...', homeid.toString(16));
	});

	zwave.on('driver failed', function () {
		console.error('ZWave: failed to start driver');
		zwave.disconnect();
		process.exit(1);
	});

	xpl.bind((error) => {
		if (error) {
			console.log("Can not open xpl bridge ", error);
			process.exit(2);
			return;
		}

		console.log("Xpl bind succeed ");

		zwave.connect(commander.serialPort); //'/dev/ttyACM1');
	});

	zwave.on('node added', (nodeid) => {
		nodes[nodeid] = {
			manufacturer: '',
			manufacturerid: '',
			product: '',
			producttype: '',
			productid: '',
			type: '',
			name: '',
			loc: '',
			classes: {},
			ready: false,
		};
		console.log("Create node", nodeid);
	});

	function constructBody(nodeid, comclass, value) {

		let label = value.instance;
		if (value.instance === 1 && value.label) {
			label = value.label;
		}

		let body = {
			device: nodeid + "/" + comclass + "/" + label + "/" + value.index,
		};

		if (!deviceAliases) {
			return body;
		}

		var da = deviceAliases[body.device];
		if (da) {
			return body;
		}

		da = deviceAliases[nodeid + "/" + comclass + "/" + label];
		if (da) {
			body.device = da + "/" + value.index;
			return body;
		}

		da = deviceAliases[nodeid + "/" + comclass];
		if (da) {
			body.device = da + "/" + label + "/" + value.index;
			return body;
		}

		da = deviceAliases[nodeid];
		if (!da) {
			return body;
		}
		body.device = da + "/" + comclass + "/" + label + "/" + value.index;

		return body;
	}

	zwave.on('value added', (nodeid, comclass, value) => {
		let n = nodes[nodeid]['classes'];
		if (!n[comclass]) {
			n[comclass] = {};
		}

		n[value.index] = value;

		let v = value.value;

		let body = constructBody(nodeid, comclass, value);
		zwaveKeys[body.device] = {
			nodeid, comclass, value
		};

		if (!value.write_only) {
			body.current = v;
			if (value.units) {
				body.units = value.units;
			}

			xpl.sendXplStat(body);
		}

		if (emulateShutters[nodeid] && comclass === 38 && value.instance === 1 && value.index === 0) {
			let es = emulateShutters[nodeid];

			es.target = normalizeShutterValue(value);
			es.state = normalizeShutterValue(value);
			es.units = "%";

			let device = nodeid;
			if (deviceAliases && deviceAliases[nodeid]) {
				device = deviceAliases[nodeid];
			}

			zwaveKeys[device] = {
				nodeid, comclass, value
			};

			xpl.sendXplStat({
				device: device,
				type: "target",
				current: es.target,
				units: '%'
			});
			xpl.sendXplStat({
				device: device,
				type: "state",
				current: es.state,
				units: '%'
			});
		}
	});

	zwave.on('value changed', (nodeid, comclass, value) => {
		let old;
		if (nodes[nodeid]['ready']) {
			console.log('node%d: changed: %d:%s:%s->%s', nodeid, comclass,
				value['label'],
				nodes[nodeid]['classes'][comclass][value.index]['value'],
				value['value']);

			old = nodes[nodeid]['classes'][comclass][value.index]['value'];
		}
		nodes[nodeid]['classes'][comclass][value.index] = value;
		debug("Value changed: nodeid=", nodeid, "comclas=", comclass, "value=", value);

		let v = value.value;

		if (!value.write_only) {
			let body = constructBody(nodeid, comclass, value);
			body.current = v;
			if (value.units) {
				body.units = value.units;
			}

			xpl.sendXplTrig(body);
		}


		if (emulateShutters[nodeid] && comclass === 38 && value.instance === 1 && value.index === 0) {
			let es = emulateShutters[nodeid];

			es.target = normalizeShutterValue(value);
			es.state = normalizeShutterValue(value);

			let device = nodeid;
			if (deviceAliases && deviceAliases[nodeid]) {
				device = deviceAliases[nodeid];
			}

			if (old !== value.value) {
				xpl.sendXplTrig({
					device: device,
					type: "target",
					current: es.target,
					units: "%"
				});
			}
			xpl.sendXplTrig({
				device: device,
				type: "state",
				current: es.state,
				units: "%"
			});
		}
	});

	zwave.on('value removed', (nodeid, comclass, index) => {
		if (nodes[nodeid]['classes'][comclass] &&
			nodes[nodeid]['classes'][comclass][index])
			delete nodes[nodeid]['classes'][comclass][index];
//console.log("Value removed: nodeid=",nodeid,"comclas=",comclass,"index=",index);
	});

	zwave.on('node ready', (nodeid, nodeinfo) => {
		let n = nodes[nodeid];
		n['manufacturer'] = nodeinfo.manufacturer;
		n['manufacturerid'] = nodeinfo.manufacturerid;
		n['product'] = nodeinfo.product;
		n['producttype'] = nodeinfo.producttype;
		n['productid'] = nodeinfo.productid;
		n['type'] = nodeinfo.type;
		n['name'] = nodeinfo.name;
		n['loc'] = nodeinfo.loc;
		n['ready'] = true;

		console.log('node%d: %s, %s',
			nodeid,
			nodeinfo.manufacturer ? nodeinfo.manufacturer : 'id=' + nodeinfo.manufacturerid,
			nodeinfo.product ? nodeinfo.product : 'product=' + nodeinfo.productid + ', type=' + nodeinfo.producttype);

		debug('node%d: name="%s", type="%s", location="%s"', nodeid, nodeinfo.name, nodeinfo.type, nodeinfo.loc);

		for (let comclass in n['classes']) {
			switch (comclass) {
//				case 0x25: // COMMAND_CLASS_SWITCH_BINARY
				case 0x26: // COMMAND_CLASS_SWITCH_MULTILEVEL
					zwave.enablePoll(nodeid, comclass, 2);
					break;
				case "38":
					console.log("*** Enable poll for nodeid=", nodeid, "comclass=", comclass);
					zwave.enablePoll(nodeid, comclass, 2);
					break;
			}

			let values = n['classes'][comclass];
			console.log('node%d: class %d', nodeid, comclass);
			for (let idx in values)
				console.log('node%d:   %s:%s=', nodeid, idx, values[idx]['label'], values[idx]);
		}


	});

	zwave.on('notification', (nodeid, notif) => {
		switch (notif) {
			case 0:
				console.log('node%d: message complete', nodeid);
				break;
			case 1:
				console.log('node%d: timeout', nodeid);
				break;
			case 2:
				console.log('node%d: nop', nodeid);
				break;
			case 3:
				console.log('node%d: node awake', nodeid);
				break;
			case 4:
				console.log('node%d: node sleep', nodeid);
				break;
			case 5:
				console.log('node%d: node dead', nodeid);
				break;
			case 6:
				console.log('node%d: node alive', nodeid);
				break;
			default:
				console.log("UNKNOWN notification", nodeid);
		}
	});

	zwave.on('scan complete', () => {
		console.log("ZWave: Scan complete");

//		zwave.setValue(5, 38, 1, 0, 0);
		/*
		 console.log('====> scan complete, hit ^C to finish.');

		 // set dimmer node 5 to 50%
		 zwave.setValue({node_id: 5, class_id: 38, instance: 1, index: 0}, 0);

		 // Add a new device to the ZWave controller
		 if (zwave.hasOwnProperty('beginControllerCommand')) {
		 // using legacy mode (OpenZWave version < 1.3) - no security
		 zwave.beginControllerCommand('AddDevice', true);

		 } else {
		 // using new security API
		 // set this to 'true' for secure devices eg. door locks
		 zwave.addNode(false);
		 }*/

		xpl.on("xpl:xpl-cmnd", (message) => {
			debug("processXplMessage", "Receive message", message);

			if (message.bodyName !== "delabarre.command" &&
				message.bodyName !== "x10.basic") {
				return;
			}

			let body = message.body;

			let command = body.command;
			let device = body.device;
			let current = body.current;

			let zwaveDevice = zwaveKeys[device];
			if (!zwaveDevice) {
				debug("Unknown device=", device);
				return;
			}

			switch (command) {
				case "target":
					let value = zwaveDevice.value;
					let nv = Math.round(parseFloat(current) / 100 * SHUTTER_MAX);

					console.log("SET VALUE nodeid=", zwaveDevice.nodeid, "comclass=", zwaveDevice.comclass, "instance=", value.instance, "index=", value.index, "value=", nv);

					zwave.setValue(zwaveDevice.nodeid, zwaveDevice.comclass, value.instance, value.index, nv);

					xpl.sendXplTrig({
						device: device,
						type: "target",
						current: current,
						units: "%"
					});
					break;
			}

		});
	});

	zwave.on('controller command', (r, s) => {
		console.log('controller commmand feedback: r=%d, s=%d', r, s);
	});


	process.on('SIGINT', function () {
		console.log('disconnecting...');
		zwave.disconnect(commander.serialPort);
		process.exit();
	});
});

function normalizeShutterValue(value) {
	let v = value.value;
	return Math.round(v / 99 * 20) * 5;
}

commander.parse(process.argv);

if (commander.heapDump) {
	var heapdump = require("heapdump");
	console.log("***** HEAPDUMP enabled **************");
}
