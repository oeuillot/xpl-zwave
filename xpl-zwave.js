const ZWave = require('openzwave-shared');
const Xpl = require('xpl-api');
const commander = require('commander');
const os = require('os');
const fs = require('fs');
const debug = require('debug')('xpl-zwave');
const debugZwave = require('debug')('xpl-zwave:zwave');

commander.version(require("./package.json").version);
commander.option("--zwave-logging", "Wave logging console");
commander.option("--zwave-console-output", "Console output");

commander.option("-s, --serialPort <path>", "Serial device path");
commander.option("--deviceAliases <path>", "Device aliases (path or string)");
commander.option("--emulateShutters <indexes>", "Indexes of emulated shutters");
commander.option("--emulateSwitchs <indexes>", "Indexes of emulated switchs");

let outputSchema;
commander.option("--outputSchema <path>", "Path to CSV output schema", (path) => {
	outputSchema = fs.openSync(path, 'w');
	fs.writeSync(outputSchema, "Body device;nodeId-classId-instance-index;type;genre;label;units;help;readOnly;write-only;min;max;value\n");

});


Xpl.fillCommander(commander);

if (!commander.xplSource) {
	var hostName = os.hostname();
	if (hostName.indexOf('.') > 0) {
		hostName = hostName.substring(0, hostName.indexOf('.'));
	}

	commander.xplSource = "zwave." + hostName;
}

var emulateShutters = {};
var emulateSwitchs = {};
var zwaveKeys = {};

const SHUTTER_MAX = 99;

let dates = {};

commander.command('*').description("Start processing Zwave").action(() => {
	console.log("Starting ...");

	const deviceAliases = Xpl.loadDeviceAliases(commander.deviceAliases);

	if (commander.emulateShutters) {
		(commander.emulateShutters || '').split(',').forEach((nodeid) => {
			let da = nodeid;
//			console.log("=>", nodeid, "=>", da, deviceAliases);

			emulateShutters[nodeid] = {state: undefined, target: undefined, device: da};
		});
	}

	if (commander.emulateSwitchs) {
		(commander.emulateSwitchs || '').split(',').forEach((nodeid) => {
			let da = nodeid;
//			console.log("=>", nodeid, "=>", da, deviceAliases);

			emulateSwitchs[nodeid] = {state: undefined, target: undefined, device: da};
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
		zwave.disconnect(commander.serialPort);
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
		console.log("nodeAdded", "Create nodeid=", nodeid);
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

		let da = deviceAliases[body.device];
		if (da) {
			body.device = da;
			return body;
		}

		da = deviceAliases[nodeid + "/" + comclass + "/" + value.instance + "/" + value.index];
		if (da) {
			body.device = da;
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

		debugZwave('ValueAdded', "New value nodeid=", nodeid, "commclass=", comclass,
			"value.label=", value['label'], "value=", value, "body=", body);

		if (outputSchema !== undefined) {
			fs.writeSync(outputSchema, body.device + ";" + value.node_id + "-" + value.class_id + "-" + value.instance + "-" + value.index + ";" + value.type + ";" + value.genre + ";" + value.label + ";" + value.units + ";" + value.help + ";" +
				value.read_only + ";" + value.write_only + ";" + value.min + ";" + value.max + ";" + value.value + "\n");
		}

		if (!value.write_only) {
			body.current = v;
			if (value.units) {
				body.units = value.units;
			}

			const nodeKey = nodeid + '-' + comclass + '-' + value.instance + '-' + value.index;
			dates[nodeKey] = Date.now();

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

		if (emulateSwitchs[nodeid] && comclass === 37 && value.instance === 1 && value.index === 0) {

			let device = nodeid;
			if (deviceAliases && deviceAliases[nodeid]) {
				device = deviceAliases[nodeid];
			}

			xpl.sendXplStat({
				device: device,
				type: "state",
				current: value ? 'enable' : 'disable',
			});
		}
	});

	zwave.on('value changed', (nodeid, comclass, value) => {
		let oldValue;
		let valueIndex = value.index || 0;

		let node = nodes[nodeid]['classes'][comclass];

		let old = node[valueIndex];
		if (old) {
			oldValue = old['value'];
		}
		let newValue = value['value'];

		debugZwave("ValueChanged", "Same Value changed: nodeid=", nodeid, "comclas=", comclass, "previousValue=", old, "newValue=", newValue, "ready=", nodes[nodeid]['ready']);

		node[valueIndex] = value;
		const nodeKey = nodeid + '-' + comclass + '-' + value.instance + '-' + value.index;

		if (!value.write_only) {
			const now = Date.now();
			let modified = false;
			if (oldValue !== newValue) {
				console.log('Value changed ' + nodeKey + ' = ' + oldValue + ' => ' + newValue);
				modified = true;
				dates[nodeKey] = now;

			} else {
				if (!dates[nodeKey] || (now - dates[nodeKey]) > 1000 * 60 * 10) {
					modified = true;
					dates[nodeKey] = now;
				} else {
					console.log('Ignore change :', nodeKey, 'value=', newValue);
				}
			}

			if (modified) {
				const body = constructBody(nodeid, comclass, value);
				body.current = newValue;
				if (value.units) {
					body.units = value.units;
				}

				console.log('  send body=', body);
				xpl.sendXplTrig(body);
			}
		}

		if (emulateShutters[nodeid] && comclass === 38 && value.instance === 1 && value.index === 0) {
			let es = emulateShutters[nodeid];

			es.target = normalizeShutterValue(value);
			es.state = normalizeShutterValue(value);

			let device = nodeid;
			if (deviceAliases && deviceAliases[nodeid]) {
				device = deviceAliases[nodeid];
			}

			if (oldValue !== value.value) {
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
			nodes[nodeid]['classes'][comclass][index]) {
			delete nodes[nodeid]['classes'][comclass][index];
		}
		debugZwave("ValueRemoved", "nodeid=", nodeid, "comclas=", comclass, "index=", index);
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

		console.log('nodeReady node=', nodeid, 'name=', nodeinfo.name,
			'type=', nodeinfo.type,
			'location=', nodeinfo.loc,
			'manufacturer=', nodeinfo.manufacturer,
			'manufacturerId=', nodeinfo.manufacturerid,
			'product=', nodeinfo.product,
			'productid=', nodeinfo.productid,
			'producttype=', nodeinfo.producttype);

		for (let comclass in n['classes']) {

			let values = n['classes'][comclass];
			console.log('  * comclass=', comclass);

			for (let idx in values) {
				const v = values[idx];
				console.log('    * idx=', idx, "label=", v['label'], "value=", v);

				if (!v || typeof (v) !== 'object' || !v.value_id) {
					continue;
				}


				switch (comclass) {
//				case 0x25: // COMMAND_CLASS_SWITCH_BINARY
					case 0x26: // COMMAND_CLASS_SWITCH_MULTILEVEL
					case 0x32: // COMMAND_CLASS_SWITCH_MULTILEVEL
					case "37":
					case "38":
//					case "39":
					case "49":
					case "50":
						debugZwave('nodeReady', "Enable pool for nodeid=", nodeid, "comclass=", comclass);
						zwave.enablePoll(v, comclass); //, 2, 0);
						break;
				}
			}
		}

		if (nodeid === 9) {
			console.log("SET to 300");
// 9-112-1-51
//			zwave.setValue(9, 112, 1, 52, 300);
//zwave.setValue('9-112-1-51', 300);
		}

		if (nodeid === 13) {
			console.log("SET 13 to 300");
// 9-112-1-51
//			zwave.setValue(13, 112, 1, 52, 300);
//zwave.setValue('9-112-1-51', 300);
		}
	});

	zwave.on('notification', (nodeid, notif) => {
		switch (notif) {
			case 0:
				debugZwave('notification', 'nodeid=', nodeid, ': message complete');
				break;
			case 1:
				debugZwave('notification', 'nodeid=', nodeid, ': timeout');
				break;
			case 2:
				debugZwave('notification', 'nodeid=', nodeid, ': nop');
				break;
			case 3:
				debugZwave('notification', 'nodeid=', nodeid, ': node awake');
				break;
			case 4:
				debugZwave('notification', 'nodeid=', nodeid, ': node sleep');
				break;
			case 5:
				debugZwave('notification', 'nodeid=', nodeid, ': node dead');
				break;
			case 6:
				debugZwave('notification', 'nodeid=', nodeid, ': node alive');
				break;
			default:
				debugZwave('notification', "UNKNOWN notification nodeid=", nodeid);
		}
	});

	zwave.on('scan complete', () => {
		debugZwave("scan complete", "ZWave: Scan complete");
		console.log("scan complete", "ZWave: Scan complete");

		// zwave.setValue({node_id: 12, class_id: 112, instance: 1, index: 13}, 1);
		//zwave.setValue({node_id: 12, class_id: 112, instance: 1, index: 14}, 0);
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

			if (message.bodyName !== "zwave.cmd") {
				return;
			}

			console.log("processXplMessage:zwave.cmd", "Receive message", message);

			debug("ZWave command=", message);

			switch (message.body.command || '') {
				case 'inclusion':
					let security = isTrue(message.body.security);
					zwave.addNode(security);
					xpl.sendXplTrig({
						device: "zwave/manager",
						type: "inclusion",
						security
					});
					break;

				case 'exclusion':
					zwave.removeNode();
					xpl.sendXplTrig({
						device: "zwave/manager",
						type: "exclusion"
					});
					break;

				default:
					console.error("Unsupported command=", message);
			}
		});

		xpl.on("message", (message) => {
			debug("processXplMessage", "Receive message", message);

			if (message.bodyName !== "delabarre.command" &&
				message.bodyName !== "x10.basic") {

//				console.log('Ignored bodyName=>', message);
				return;
			}

			let body = message.body;

			let command = body.command;
			let device = body.device || body.unit;
			let current = body.current;

			console.log('Get message  command=', command, 'device=', device, 'current=', current);

			switch (command) {
				case "setValue":
					const req = /^zwave\/([\d]+)-([\d]+)-([\d]+)-([\d]+)$/.exec(device);
					if (req) {
						const obj = {
							node_id: parseInt(req[1], 10),
							class_id: parseInt(req[2], 10),
							instance: parseInt(req[3], 10),
							index: parseInt(req[4], 10)
						};

						if (current === 'true') {
							current = true;

						} else if (current === 'false') {
							current = false;

						} else if (/^[\d\.]+$/.exec(current)) {
							current = parseFloat(current);
						}

						console.log("command", "[n-c-i-i] SET VALUE obj=", obj, "value=", current, typeof (current));

						zwave.setValue(obj.node_id, obj.class_id, obj.instance, obj.index, current);
						return;
					}
					break;
			}

			let zwaveDevice = zwaveKeys[device];
			console.log('Map device name=', device, '=> device=', zwaveDevice);
			if (!zwaveDevice && body.command) {
				let newDevice = device + '/' + body.command;
				zwaveDevice = zwaveKeys[newDevice];
				console.log('Map device with command name=', newDevice, '=> device=', zwaveDevice);
				if (zwaveDevice) {
					device = newDevice;
				}
			}

			if (!zwaveDevice) {
				console.error("Unknown device=", device, 'aliases=', zwaveKeys);
				return;
			}

			switch (command) {
				case "status":
				case "enabled": {
					let value = zwaveDevice.value;
					let nv = isTrue(current) ? 1 : 0;

					console.log("command", "[enabled] SET VALUE nodeid=", zwaveDevice.nodeid, "comclass=", zwaveDevice.comclass, "instance=", value.instance, "index=", value.index, "value=", nv);

					zwave.setValue(zwaveDevice.nodeid, zwaveDevice.comclass, value.instance, value.index, nv);
					return;
				}

				case "setValue":
				case "value": {
					let value = zwaveDevice.value;
					let nv = parseFloat(current);

					console.log("command", "[value] SET VALUE nodeid=", zwaveDevice.nodeid, "comclass=", zwaveDevice.comclass, "instance=", value.instance, "index=", value.index, "value=", nv);

					zwave.setValue(zwaveDevice.nodeid, zwaveDevice.comclass, value.instance, value.index, nv);
					return;
				}

				case "target": {
					let value = zwaveDevice.value;
					let nv = Math.round(parseFloat(current) / 100 * SHUTTER_MAX);

					console.log("command", "[target] SET VALUE nodeid=", zwaveDevice.nodeid, "comclass=", zwaveDevice.comclass, "instance=", value.instance, "index=", value.index, "value=", nv);

					zwave.setValue(zwaveDevice.nodeid, zwaveDevice.comclass, value.instance, value.index, nv);

					xpl.sendXplTrig({
						device: device,
						type: "target",
						current: current,
						units: "%"
					});
					break;
				}
			}

		});
	});

	zwave.on('controller command', (r, s) => {
		debugZwave('controller commmand', 'Get feedback: r=', r, 's=', s);
	});


	process.on('SIGINT', function () {
		console.log('disconnecting...');
		zwave.disconnect(commander.serialPort);
		process.exit();
	});
})
;

function normalizeShutterValue(value) {
	let v = value.value;
	return Math.round(v / 99 * 20) * 5;
}

function isTrue(value, defaultValue) {
	if (typeof (value) === "boolean") {
		return value;
	}

	if (typeof (value) === "string") {
		let reg = /^(true|1|t|ok|on|active|enable|enabled)$/i.exec(value);
		return !!reg;
	}

	if (typeof (value) === "number") {
		return !!value;
	}

	return !!value;
}


commander.parse(process.argv);

if (commander.heapDump) {
	var heapdump = require("heapdump");
	console.log("***** HEAPDUMP enabled **************");
}
