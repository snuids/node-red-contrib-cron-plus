const parser = require('cronstrue');
const cronosjs = require("cronosjs");
const prettyMs = require('pretty-ms');

/**
 * Humanize a cron express
 * @param {string} expression the CRON expression to humanize
 * @returns {string}
 * 			A human readable version of the expression 
 */
var humanizeCron = function (expression) {
	try {
		return parser.toString(expression);
	} catch (error) {
		return `Cannot parse expression '${expression}'`
	}
}

/**
 * Returns a formatted string based on the provided tz.
 * If tz is not specified, then Date.toString() is used
 * @param {Date | string | number} date The date to format
 * @param {string} [tz] Timezone to use (exclude to use system)
 * @returns {string}
 * 			The formatted date or empty string if `date` is null|undefined
 */
function formatDateTimeWithTZ(date, tz) {
	if (!date) {
		return "";
	}
	let prettyNextDate;
	if (tz) {
		let o = {
			timeZone: tz,
			timeZoneName: "short",
			weekday: "short",
			hour12: false,
			year: "numeric",
			month: "short",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit"
		};
		try {
			prettyNextDate = new Intl.DateTimeFormat('default', o).format(new Date(date))	
		} catch (error) {
			prettyNextDate = "Error. Check timezone setting"
		}
		
	} else {
		prettyNextDate = Date(date).toString();
	}
	return prettyNextDate;
}

module.exports = function (RED) {
	function CronPlus(n) {
		RED.nodes.createNode(this, n);
		var node = this;
		node.topic = n.topic;
		node.name = n.name;
		node.payload = n.payload;
		node.payloadType = n.payloadType || "date";
		node.crontab = n.crontab;
		node.outputField = n.outputField || "payload";
		node.timeZone = n.timeZone;

		const setResult = function (msg, field, value) {
			const set = (obj, path, val) => {
				const keys = path.split('.');
				const lastKey = keys.pop();
				const lastObj = keys.reduce((obj, key) =>
					obj[key] = obj[key] || {},
					obj);
				lastObj[lastKey] = val;
			}
			set(msg, field, value);
		};

		const updateDoneStatus = (node) => {
			node.status({ fill: "green", shape: "dot", text: "Done " + formatDateTimeWithTZ(Date.now(), node.timeZone) });
			if (node.nextDate) {
				let now = Date.now();
				let next = new Date(node.nextDate).valueOf();
				//node.nextDate
				let msTillNext = next - now;
				if (msTillNext > 5000)
					setTimeout(() => {
						node.status({ fill: "blue", shape: "dot", text: "Next Run " + formatDateTimeWithTZ(node.nextDate, node.timeZone) });
					}, 4000);
			}
		}

		const sendMsg = (node, msg) => {
			msg.topic = node.topic;
			node.status({ fill: "green", shape: "ring", text: "Job started" });
			if (node.payloadType !== 'flow' && node.payloadType !== 'global') {
				try {
					let pl;
					if ((node.payloadType == null && node.payload === "") || node.payloadType === "date") {
						pl = Date.now();
					} else if (node.payloadType == null) {
						pl = node.payload;
					} else if (node.payloadType === 'none') {
						pl = "";
					} else {
						pl = RED.util.evaluateNodeProperty(node.payload, node.payloadType, node, msg);
					}
					setResult(msg, node.outputField, pl);
					node.send(msg);
					node.status({ fill: "green", shape: "dot", text: "Done " + formatDateTimeWithTZ(Date.now(), node.timeZone) });
					updateDoneStatus(node);
				} catch (err) {
					node.error(err, msg);
				}
			} else {
				RED.util.evaluateNodeProperty(node.payload, node.payloadType, node, msg, function (err, res) {
					if (err) {
						node.error(err, msg);
					} else {
						setResult(msg, node.outputField, res);
						node.send(msg);
						updateDoneStatus(node);
					}
				});
			}
		}

		try {
			node.nextDate = null;
			if (node.task) {
				node.task.stop()
			}
			let cronExpression = n.crontab;
			let exOk = cronosjs.validate(cronExpression);
			if (!exOk) {
				node.status({ fill: "red", shape: "dot", text: "Cannot validate CRON expression" });
				return;
			}
			let opts = node.timeZone ? { timezone: node.timeZone } : undefined;
			let expression = cronosjs.CronosExpression.parse(cronExpression, opts)
			node.task = new cronosjs.CronosTask(expression);
			node.task.stop();
			node.nextDate = null;
			node.task
				.on('run', (timestamp) => {
					node.debug(`topic: ${node.topic}\n now time ${new Date()}\n crontime ${new Date(timestamp)}`)
					node.status({ fill: "green", shape: "ring", text: "Running task " + formatDateTimeWithTZ(timestamp, node.timeZone) });
					node.nextDate = node.task._expression.nextDate();
					sendMsg(node, { crontime: timestamp, nextDate: node.nextDate });
				})
				.on('ended', () => {
					node.status({ fill: "grey", shape: "dot", text: "Job ended" });
				})
				.on('started', () => {
					let now = new Date();
					let next = node.task._expression.nextDate(now);
					node.status({ fill: "blue", shape: "dot", text: "Next run: " + formatDateTimeWithTZ(next, node.timeZone) });
				})
				.on('stopped', () => {
					node.status({ fill: "blue", shape: "dot", text: "Job stopped" });
				});

			node.task.start();
			node.on('close', function (done) {
				if (node.task) {
					node.task.stop()
				}
				done();
			});
		} catch (err) {
			if (node.task) {
				node.task.stop()
			}
			node.status({ fill: "red", shape: "dot", text: "Error creating Job" });
			node.error(err);
		}
		this.on("input", function (msg) {
			sendMsg(node, msg);
		});
	}
	RED.nodes.registerType("cronplus", CronPlus);

	RED.httpAdmin.post("/cronplus/:id", RED.auth.needsPermission("cronplus.write"), function (req, res) {
		var node = RED.nodes.getNode(req.params.id);
		if (node != null) {
			try {
				node.receive();
				res.sendStatus(200);
			} catch (err) {
				res.sendStatus(500);
				node.error(RED._("inject.failed", { error: err.toString() }));
			}
		} else {
			res.sendStatus(404);
		}
	});

	RED.httpAdmin.post("/cronplus", RED.auth.needsPermission("cronplus.read"), function (req, res) {
		var e = req.body.expression;
		var opts = req.body.timeZone ? { timezone: req.body.timeZone } : undefined;
		try {
			let exOk = cronosjs.validate(e);
			if (exOk) {
				let ex = cronosjs.CronosExpression.parse(e, opts);
				let now = new Date();
				let next = ex.nextDate(now);
				let prettyNext = "Never";
				let nextDates;
				if (next) {
					let ms = next.valueOf() - now.valueOf();
					prettyNext = `in ${prettyMs(ms, { secondsDecimalDigits: 0, verbose: true })}`;
					try {
						nextDates = ex.nextNDates(next, 5);
					} catch (error) {
						node.debug(error);
					}
				}
				let desc = humanizeCron(e);
				let r = { expression: e, description: desc, next: next, prettyNext: prettyNext, nextDates: nextDates };
				res.json(r);
			} else {
				let r = { expression: e, description: "Invalid or unsupported expression" };
				res.json(r);
			}
		} catch (err) {
			res.sendStatus(500);
			console.error(err)
		}
	});

	RED.httpAdmin.post("/cronplustz", RED.auth.needsPermission("cronplus.read"), function (req, res) {
		try {
			res.json(timeZones);
		} catch (err) {
			res.sendStatus(500);
			console.error(err)
		}
	});
};



/**
 * Array of timezones
 */
const timeZones = [
	{ "code": "CI", "latLon": "+0519-00402", "tz": "Africa/Abidjan", "UTCOffset": "+00:00", "UTCDSTOffset": "+00:00" },
	{ "code": "GH", "latLon": "+0533-00013", "tz": "Africa/Accra", "UTCOffset": "+00:00", "UTCDSTOffset": "+00:00" },
	{ "code": "DZ", "latLon": "3950", "tz": "Africa/Algiers", "UTCOffset": "+01:00", "UTCDSTOffset": "+01:00" },
	{ "code": "GW", "latLon": "+1151-01535", "tz": "Africa/Bissau", "UTCOffset": "+00:00", "UTCDSTOffset": "+00:00" },
	{ "code": "EG", "latLon": "6118", "tz": "Africa/Cairo", "UTCOffset": "+02:00", "UTCDSTOffset": "+02:00" },
	{ "code": "MA", "latLon": "+3339-00735", "tz": "Africa/Casablanca", "UTCOffset": "+01:00", "UTCDSTOffset": "+01:00" },
	{ "code": "ES", "latLon": "+3553-00519", "tz": "Africa/Ceuta", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "EH", "latLon": "+2709-01312", "tz": "Africa/El_Aaiun", "UTCOffset": "+00:00", "UTCDSTOffset": "+01:00" },
	{ "code": "ZA", "latLon": "-2615+02800", "tz": "Africa/Johannesburg", "UTCOffset": "+02:00", "UTCDSTOffset": "+02:00" },
	{ "code": "SS", "latLon": "3587", "tz": "Africa/Juba", "UTCOffset": "+03:00", "UTCDSTOffset": "+03:00" },
	{ "code": "SD", "latLon": "4768", "tz": "Africa/Khartoum", "UTCOffset": "+02:00", "UTCDSTOffset": "+02:00" },
	{ "code": "NG", "latLon": "951", "tz": "Africa/Lagos", "UTCOffset": "+01:00", "UTCDSTOffset": "+01:00" },
	{ "code": "MZ", "latLon": "-2558+03235", "tz": "Africa/Maputo", "UTCOffset": "+02:00", "UTCDSTOffset": "+02:00" },
	{ "code": "LR", "latLon": "+0618-01047", "tz": "Africa/Monrovia", "UTCOffset": "+00:00", "UTCDSTOffset": "+00:00" },
	{ "code": "KE", "latLon": "-0117+03649", "tz": "Africa/Nairobi", "UTCOffset": "+03:00", "UTCDSTOffset": "+03:00" },
	{ "code": "TD", "latLon": "2710", "tz": "Africa/Ndjamena", "UTCOffset": "+01:00", "UTCDSTOffset": "+01:00" },
	{ "code": "LY", "latLon": "4565", "tz": "Africa/Tripoli", "UTCOffset": "+02:00", "UTCDSTOffset": "+02:00" },
	{ "code": "TN", "latLon": "4659", "tz": "Africa/Tunis", "UTCOffset": "+01:00", "UTCDSTOffset": "+01:00" },
	{ "code": "NA", "latLon": "-2234+01706", "tz": "Africa/Windhoek", "UTCOffset": "+02:00", "UTCDSTOffset": "+02:00" },
	{ "code": "US", "latLon": "+515248-1763929", "tz": "America/Adak", "UTCOffset": "-10:00", "UTCDSTOffset": "-09:00" },
	{ "code": "US", "latLon": "+611305-1495401", "tz": "America/Anchorage", "UTCOffset": "-09:00", "UTCDSTOffset": "-08:00" },
	{ "code": "BR", "latLon": "-0712-04812", "tz": "America/Araguaina", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "AR", "latLon": "-3436-05827", "tz": "America/Argentina/Buenos_Aires", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "AR", "latLon": "-2828-06547", "tz": "America/Argentina/Catamarca", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "AR", "latLon": "-3124-06411", "tz": "America/Argentina/Cordoba", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "AR", "latLon": "-2411-06518", "tz": "America/Argentina/Jujuy", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "AR", "latLon": "-2926-06651", "tz": "America/Argentina/La_Rioja", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "AR", "latLon": "-3253-06849", "tz": "America/Argentina/Mendoza", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "AR", "latLon": "-5138-06913", "tz": "America/Argentina/Rio_Gallegos", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "AR", "latLon": "-2447-06525", "tz": "America/Argentina/Salta", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "AR", "latLon": "-3132-06831", "tz": "America/Argentina/San_Juan", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "AR", "latLon": "-3319-06621", "tz": "America/Argentina/San_Luis", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "AR", "latLon": "-2649-06513", "tz": "America/Argentina/Tucuman", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "AR", "latLon": "-5448-06818", "tz": "America/Argentina/Ushuaia", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "PY", "latLon": "-2516-05740", "tz": "America/Asuncion", "UTCOffset": "-04:00", "UTCDSTOffset": "-03:00" },
	{ "code": "CA", "latLon": "+484531-0913718", "tz": "America/Atikokan", "UTCOffset": "-05:00", "UTCDSTOffset": "-05:00" },
	{ "code": "BR", "latLon": "-1259-03831", "tz": "America/Bahia", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "MX", "latLon": "+2048-10515", "tz": "America/Bahia_Banderas", "UTCOffset": "-06:00", "UTCDSTOffset": "-05:00" },
	{ "code": "BB", "latLon": "+1306-05937", "tz": "America/Barbados", "UTCOffset": "-04:00", "UTCDSTOffset": "-04:00" },
	{ "code": "BR", "latLon": "-0127-04829", "tz": "America/Belem", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "BZ", "latLon": "+1730-08812", "tz": "America/Belize", "UTCOffset": "-06:00", "UTCDSTOffset": "-06:00" },
	{ "code": "CA", "latLon": "+5125-05707", "tz": "America/Blanc-Sablon", "UTCOffset": "-04:00", "UTCDSTOffset": "-04:00" },
	{ "code": "BR", "latLon": "+0249-06040", "tz": "America/Boa_Vista", "UTCOffset": "-04:00", "UTCDSTOffset": "-04:00" },
	{ "code": "CO", "latLon": "+0436-07405", "tz": "America/Bogota", "UTCOffset": "-05:00", "UTCDSTOffset": "-05:00" },
	{ "code": "US", "latLon": "+433649-1161209", "tz": "America/Boise", "UTCOffset": "-07:00", "UTCDSTOffset": "-06:00" },
	{ "code": "CA", "latLon": "+690650-1050310", "tz": "America/Cambridge_Bay", "UTCOffset": "-07:00", "UTCDSTOffset": "-06:00" },
	{ "code": "BR", "latLon": "-2027-05437", "tz": "America/Campo_Grande", "UTCOffset": "-04:00", "UTCDSTOffset": "-03:00" },
	{ "code": "MX", "latLon": "+2105-08646", "tz": "America/Cancun", "UTCOffset": "-05:00", "UTCDSTOffset": "-05:00" },
	{ "code": "VE", "latLon": "+1030-06656", "tz": "America/Caracas", "UTCOffset": "-04:00", "UTCDSTOffset": "-04:00" },
	{ "code": "GF", "latLon": "+0456-05220", "tz": "America/Cayenne", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "US", "latLon": "+4151-08739", "tz": "America/Chicago", "UTCOffset": "-06:00", "UTCDSTOffset": "-05:00" },
	{ "code": "MX", "latLon": "+2838-10605", "tz": "America/Chihuahua", "UTCOffset": "-07:00", "UTCDSTOffset": "-06:00" },
	{ "code": "CR", "latLon": "+0956-08405", "tz": "America/Costa_Rica", "UTCOffset": "-06:00", "UTCDSTOffset": "-06:00" },
	{ "code": "CA", "latLon": "+4906-11631", "tz": "America/Creston", "UTCOffset": "-07:00", "UTCDSTOffset": "-07:00" },
	{ "code": "BR", "latLon": "-1535-05605", "tz": "America/Cuiaba", "UTCOffset": "-04:00", "UTCDSTOffset": "-03:00" },
	{ "code": "CW", "latLon": "+1211-06900", "tz": "America/Curacao", "UTCOffset": "-04:00", "UTCDSTOffset": "-04:00" },
	{ "code": "GL", "latLon": "+7646-01840", "tz": "America/Danmarkshavn", "UTCOffset": "+00:00", "UTCDSTOffset": "+00:00" },
	{ "code": "CA", "latLon": "+6404-13925", "tz": "America/Dawson", "UTCOffset": "-08:00", "UTCDSTOffset": "-07:00" },
	{ "code": "CA", "latLon": "+5946-12014", "tz": "America/Dawson_Creek", "UTCOffset": "-07:00", "UTCDSTOffset": "-07:00" },
	{ "code": "US", "latLon": "+394421-1045903", "tz": "America/Denver", "UTCOffset": "-07:00", "UTCDSTOffset": "-06:00" },
	{ "code": "US", "latLon": "+421953-0830245", "tz": "America/Detroit", "UTCOffset": "-05:00", "UTCDSTOffset": "-04:00" },
	{ "code": "CA", "latLon": "+5333-11328", "tz": "America/Edmonton", "UTCOffset": "-07:00", "UTCDSTOffset": "-06:00" },
	{ "code": "BR", "latLon": "-0640-06952", "tz": "America/Eirunepe", "UTCOffset": "-05:00", "UTCDSTOffset": "-05:00" },
	{ "code": "SV", "latLon": "+1342-08912", "tz": "America/El_Salvador", "UTCOffset": "-06:00", "UTCDSTOffset": "-06:00" },
	{ "code": "CA", "latLon": "+5848-12242", "tz": "America/Fort_Nelson", "UTCOffset": "-07:00", "UTCDSTOffset": "-07:00" },
	{ "code": "BR", "latLon": "-0343-03830", "tz": "America/Fortaleza", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "CA", "latLon": "+4612-05957", "tz": "America/Glace_Bay", "UTCOffset": "-04:00", "UTCDSTOffset": "-03:00" },
	{ "code": "GL", "latLon": "+6411-05144", "tz": "America/Godthab", "UTCOffset": "-03:00", "UTCDSTOffset": "-02:00" },
	{ "code": "CA", "latLon": "+5320-06025", "tz": "America/Goose_Bay", "UTCOffset": "-04:00", "UTCDSTOffset": "-03:00" },
	{ "code": "TC", "latLon": "+2128-07108", "tz": "America/Grand_Turk", "UTCOffset": "-05:00", "UTCDSTOffset": "-04:00" },
	{ "code": "GT", "latLon": "+1438-09031", "tz": "America/Guatemala", "UTCOffset": "-06:00", "UTCDSTOffset": "-06:00" },
	{ "code": "EC", "latLon": "-0210-07950", "tz": "America/Guayaquil", "UTCOffset": "-05:00", "UTCDSTOffset": "-05:00" },
	{ "code": "GY", "latLon": "+0648-05810", "tz": "America/Guyana", "UTCOffset": "-04:00", "UTCDSTOffset": "-04:00" },
	{ "code": "CA", "latLon": "+4439-06336", "tz": "America/Halifax", "UTCOffset": "-04:00", "UTCDSTOffset": "-03:00" },
	{ "code": "CU", "latLon": "+2308-08222", "tz": "America/Havana", "UTCOffset": "-05:00", "UTCDSTOffset": "-04:00" },
	{ "code": "MX", "latLon": "+2904-11058", "tz": "America/Hermosillo", "UTCOffset": "-07:00", "UTCDSTOffset": "-07:00" },
	{ "code": "US", "latLon": "+394606-0860929", "tz": "America/Indiana/Indianapolis", "UTCOffset": "-05:00", "UTCDSTOffset": "-04:00" },
	{ "code": "US", "latLon": "+411745-0863730", "tz": "America/Indiana/Knox", "UTCOffset": "-06:00", "UTCDSTOffset": "-05:00" },
	{ "code": "US", "latLon": "+382232-0862041", "tz": "America/Indiana/Marengo", "UTCOffset": "-05:00", "UTCDSTOffset": "-04:00" },
	{ "code": "US", "latLon": "+382931-0871643", "tz": "America/Indiana/Petersburg", "UTCOffset": "-05:00", "UTCDSTOffset": "-04:00" },
	{ "code": "US", "latLon": "+375711-0864541", "tz": "America/Indiana/Tell_City", "UTCOffset": "-06:00", "UTCDSTOffset": "-05:00" },
	{ "code": "US", "latLon": "+384452-0850402", "tz": "America/Indiana/Vevay", "UTCOffset": "-05:00", "UTCDSTOffset": "-04:00" },
	{ "code": "US", "latLon": "+384038-0873143", "tz": "America/Indiana/Vincennes", "UTCOffset": "-05:00", "UTCDSTOffset": "-04:00" },
	{ "code": "US", "latLon": "+410305-0863611", "tz": "America/Indiana/Winamac", "UTCOffset": "-05:00", "UTCDSTOffset": "-04:00" },
	{ "code": "CA", "latLon": "+682059-13343", "tz": "America/Inuvik", "UTCOffset": "-07:00", "UTCDSTOffset": "-06:00" },
	{ "code": "CA", "latLon": "+6344-06828", "tz": "America/Iqaluit", "UTCOffset": "-05:00", "UTCDSTOffset": "-04:00" },
	{ "code": "JM", "latLon": "+175805-0764736", "tz": "America/Jamaica", "UTCOffset": "-05:00", "UTCDSTOffset": "-05:00" },
	{ "code": "US", "latLon": "+581807-1342511", "tz": "America/Juneau", "UTCOffset": "-09:00", "UTCDSTOffset": "-08:00" },
	{ "code": "US", "latLon": "+381515-0854534", "tz": "America/Kentucky/Louisville", "UTCOffset": "-05:00", "UTCDSTOffset": "-04:00" },
	{ "code": "US", "latLon": "+364947-0845057", "tz": "America/Kentucky/Monticello", "UTCOffset": "-05:00", "UTCDSTOffset": "-04:00" },
	{ "code": "BO", "latLon": "-1630-06809", "tz": "America/La_Paz", "UTCOffset": "-04:00", "UTCDSTOffset": "-04:00" },
	{ "code": "PE", "latLon": "-1203-07703", "tz": "America/Lima", "UTCOffset": "-05:00", "UTCDSTOffset": "-05:00" },
	{ "code": "US", "latLon": "+340308-1181434", "tz": "America/Los_Angeles", "UTCOffset": "-08:00", "UTCDSTOffset": "-07:00" },
	{ "code": "BR", "latLon": "-0940-03543", "tz": "America/Maceio", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "NI", "latLon": "+1209-08617", "tz": "America/Managua", "UTCOffset": "-06:00", "UTCDSTOffset": "-06:00" },
	{ "code": "BR", "latLon": "-0308-06001", "tz": "America/Manaus", "UTCOffset": "-04:00", "UTCDSTOffset": "-04:00" },
	{ "code": "MQ", "latLon": "+1436-06105", "tz": "America/Martinique", "UTCOffset": "-04:00", "UTCDSTOffset": "-04:00" },
	{ "code": "MX", "latLon": "+2550-09730", "tz": "America/Matamoros", "UTCOffset": "-06:00", "UTCDSTOffset": "-05:00" },
	{ "code": "MX", "latLon": "+2313-10625", "tz": "America/Mazatlan", "UTCOffset": "-07:00", "UTCDSTOffset": "-06:00" },
	{ "code": "US", "latLon": "+450628-0873651", "tz": "America/Menominee", "UTCOffset": "-06:00", "UTCDSTOffset": "-05:00" },
	{ "code": "MX", "latLon": "+2058-08937", "tz": "America/Merida", "UTCOffset": "-06:00", "UTCDSTOffset": "-05:00" },
	{ "code": "US", "latLon": "+550737-1313435", "tz": "America/Metlakatla", "UTCOffset": "-09:00", "UTCDSTOffset": "-08:00" },
	{ "code": "MX", "latLon": "+1924-09909", "tz": "America/Mexico_City", "UTCOffset": "-06:00", "UTCDSTOffset": "-05:00" },
	{ "code": "PM", "latLon": "+4703-05620", "tz": "America/Miquelon", "UTCOffset": "-03:00", "UTCDSTOffset": "-02:00" },
	{ "code": "CA", "latLon": "+4606-06447", "tz": "America/Moncton", "UTCOffset": "-04:00", "UTCDSTOffset": "-03:00" },
	{ "code": "MX", "latLon": "+2540-10019", "tz": "America/Monterrey", "UTCOffset": "-06:00", "UTCDSTOffset": "-05:00" },
	{ "code": "UY", "latLon": "-3453-05611", "tz": "America/Montevideo", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "BS", "latLon": "+2505-07721", "tz": "America/Nassau", "UTCOffset": "-05:00", "UTCDSTOffset": "-04:00" },
	{ "code": "US", "latLon": "+404251-0740023", "tz": "America/New_York", "UTCOffset": "-05:00", "UTCDSTOffset": "-04:00" },
	{ "code": "CA", "latLon": "+4901-08816", "tz": "America/Nipigon", "UTCOffset": "-05:00", "UTCDSTOffset": "-04:00" },
	{ "code": "US", "latLon": "+643004-1652423", "tz": "America/Nome", "UTCOffset": "-09:00", "UTCDSTOffset": "-08:00" },
	{ "code": "BR", "latLon": "-0351-03225", "tz": "America/Noronha", "UTCOffset": "-02:00", "UTCDSTOffset": "-02:00" },
	{ "code": "US", "latLon": "+471551-1014640", "tz": "America/North_Dakota/Beulah", "UTCOffset": "-06:00", "UTCDSTOffset": "-05:00" },
	{ "code": "US", "latLon": "+470659-1011757", "tz": "America/North_Dakota/Center", "UTCOffset": "-06:00", "UTCDSTOffset": "-05:00" },
	{ "code": "US", "latLon": "+465042-1012439", "tz": "America/North_Dakota/New_Salem", "UTCOffset": "-06:00", "UTCDSTOffset": "-05:00" },
	{ "code": "MX", "latLon": "+2934-10425", "tz": "America/Ojinaga", "UTCOffset": "-07:00", "UTCDSTOffset": "-06:00" },
	{ "code": "PA", "latLon": "+0858-07932", "tz": "America/Panama", "UTCOffset": "-05:00", "UTCDSTOffset": "-05:00" },
	{ "code": "CA", "latLon": "+6608-06544", "tz": "America/Pangnirtung", "UTCOffset": "-05:00", "UTCDSTOffset": "-04:00" },
	{ "code": "SR", "latLon": "+0550-05510", "tz": "America/Paramaribo", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "US", "latLon": "+332654-1120424", "tz": "America/Phoenix", "UTCOffset": "-07:00", "UTCDSTOffset": "-07:00" },
	{ "code": "TT", "latLon": "+1039-06131", "tz": "America/Port_of_Spain", "UTCOffset": "-04:00", "UTCDSTOffset": "-04:00" },
	{ "code": "HT", "latLon": "+1832-07220", "tz": "America/Port-au-Prince", "UTCOffset": "-05:00", "UTCDSTOffset": "-04:00" },
	{ "code": "BR", "latLon": "-0846-06354", "tz": "America/Porto_Velho", "UTCOffset": "-04:00", "UTCDSTOffset": "-04:00" },
	{ "code": "PR", "latLon": "+182806-0660622", "tz": "America/Puerto_Rico", "UTCOffset": "-04:00", "UTCDSTOffset": "-04:00" },
	{ "code": "CL", "latLon": "-5309-07055", "tz": "America/Punta_Arenas", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "CA", "latLon": "+4843-09434", "tz": "America/Rainy_River", "UTCOffset": "-06:00", "UTCDSTOffset": "-05:00" },
	{ "code": "CA", "latLon": "+6249-0920459", "tz": "America/Rankin_Inlet", "UTCOffset": "-06:00", "UTCDSTOffset": "-05:00" },
	{ "code": "BR", "latLon": "-0803-03454", "tz": "America/Recife", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "CA", "latLon": "+5024-10439", "tz": "America/Regina", "UTCOffset": "-06:00", "UTCDSTOffset": "-06:00" },
	{ "code": "CA", "latLon": "+744144-0944945", "tz": "America/Resolute", "UTCOffset": "-06:00", "UTCDSTOffset": "-05:00" },
	{ "code": "BR", "latLon": "-0958-06748", "tz": "America/Rio_Branco", "UTCOffset": "-05:00", "UTCDSTOffset": "-05:00" },
	{ "code": "BR", "latLon": "-0226-05452", "tz": "America/Santarem", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "CL", "latLon": "-3327-07040", "tz": "America/Santiago", "UTCOffset": "-04:00", "UTCDSTOffset": "-03:00" },
	{ "code": "DO", "latLon": "+1828-06954", "tz": "America/Santo_Domingo", "UTCOffset": "-04:00", "UTCDSTOffset": "-04:00" },
	{ "code": "BR", "latLon": "-2332-04637", "tz": "America/Sao_Paulo", "UTCOffset": "-03:00", "UTCDSTOffset": "-02:00" },
	{ "code": "GL", "latLon": "+7029-02158", "tz": "America/Scoresbysund", "UTCOffset": "-01:00", "UTCDSTOffset": "+00:00" },
	{ "code": "US", "latLon": "+571035-1351807", "tz": "America/Sitka", "UTCOffset": "-09:00", "UTCDSTOffset": "-08:00" },
	{ "code": "CA", "latLon": "+4734-05243", "tz": "America/St_Johns", "UTCOffset": "-03:30", "UTCDSTOffset": "-02:30" },
	{ "code": "CA", "latLon": "+5017-10750", "tz": "America/Swift_Current", "UTCOffset": "-06:00", "UTCDSTOffset": "-06:00" },
	{ "code": "HN", "latLon": "+1406-08713", "tz": "America/Tegucigalpa", "UTCOffset": "-06:00", "UTCDSTOffset": "-06:00" },
	{ "code": "GL", "latLon": "+7634-06847", "tz": "America/Thule", "UTCOffset": "-04:00", "UTCDSTOffset": "-03:00" },
	{ "code": "CA", "latLon": "+4823-08915", "tz": "America/Thunder_Bay", "UTCOffset": "-05:00", "UTCDSTOffset": "-04:00" },
	{ "code": "MX", "latLon": "+3232-11701", "tz": "America/Tijuana", "UTCOffset": "-08:00", "UTCDSTOffset": "-07:00" },
	{ "code": "CA", "latLon": "+4339-07923", "tz": "America/Toronto", "UTCOffset": "-05:00", "UTCDSTOffset": "-04:00" },
	{ "code": "CA", "latLon": "+4916-12307", "tz": "America/Vancouver", "UTCOffset": "-08:00", "UTCDSTOffset": "-07:00" },
	{ "code": "CA", "latLon": "+6043-13503", "tz": "America/Whitehorse", "UTCOffset": "-08:00", "UTCDSTOffset": "-07:00" },
	{ "code": "CA", "latLon": "+4953-09709", "tz": "America/Winnipeg", "UTCOffset": "-06:00", "UTCDSTOffset": "-05:00" },
	{ "code": "US", "latLon": "+593249-1394338", "tz": "America/Yakutat", "UTCOffset": "-09:00", "UTCDSTOffset": "-08:00" },
	{ "code": "CA", "latLon": "+6227-11421", "tz": "America/Yellowknife", "UTCOffset": "-07:00", "UTCDSTOffset": "-06:00" },
	{ "code": "AQ", "latLon": "-6617+11031", "tz": "Antarctica/Casey", "UTCOffset": "+11:00", "UTCDSTOffset": "+11:00" },
	{ "code": "AQ", "latLon": "-6835+07758", "tz": "Antarctica/Davis", "UTCOffset": "+07:00", "UTCDSTOffset": "+07:00" },
	{ "code": "AQ", "latLon": "-6640+14001", "tz": "Antarctica/DumontDUrville", "UTCOffset": "+10:00", "UTCDSTOffset": "+10:00" },
	{ "code": "AU", "latLon": "-5430+15857", "tz": "Antarctica/Macquarie", "UTCOffset": "+11:00", "UTCDSTOffset": "+11:00" },
	{ "code": "AQ", "latLon": "-6736+06253", "tz": "Antarctica/Mawson", "UTCOffset": "+05:00", "UTCDSTOffset": "+05:00" },
	{ "code": "AQ", "latLon": "-6448-06406", "tz": "Antarctica/Palmer", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "AQ", "latLon": "-6734-06808", "tz": "Antarctica/Rothera", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "AQ", "latLon": "-690022+0393524", "tz": "Antarctica/Syowa", "UTCOffset": "+03:00", "UTCDSTOffset": "+03:00" },
	{ "code": "AQ", "latLon": "-720041+0023206", "tz": "Antarctica/Troll", "UTCOffset": "+00:00", "UTCDSTOffset": "+02:00" },
	{ "code": "AQ", "latLon": "-7824+10654", "tz": "Antarctica/Vostok", "UTCOffset": "+06:00", "UTCDSTOffset": "+06:00" },
	{ "code": "KZ", "latLon": "11972", "tz": "Asia/Almaty", "UTCOffset": "+06:00", "UTCDSTOffset": "+06:00" },
	{ "code": "JO", "latLon": "6713", "tz": "Asia/Amman", "UTCOffset": "+02:00", "UTCDSTOffset": "+03:00" },
	{ "code": "RU", "latLon": "24174", "tz": "Asia/Anadyr", "UTCOffset": "+12:00", "UTCDSTOffset": "+12:00" },
	{ "code": "KZ", "latLon": "9447", "tz": "Asia/Aqtau", "UTCOffset": "+05:00", "UTCDSTOffset": "+05:00" },
	{ "code": "KZ", "latLon": "10727", "tz": "Asia/Aqtobe", "UTCOffset": "+05:00", "UTCDSTOffset": "+05:00" },
	{ "code": "TM", "latLon": "9580", "tz": "Asia/Ashgabat", "UTCOffset": "+05:00", "UTCDSTOffset": "+05:00" },
	{ "code": "KZ", "latLon": "9863", "tz": "Asia/Atyrau", "UTCOffset": "+05:00", "UTCDSTOffset": "+05:00" },
	{ "code": "IQ", "latLon": "7746", "tz": "Asia/Baghdad", "UTCOffset": "+03:00", "UTCDSTOffset": "+03:00" },
	{ "code": "AZ", "latLon": "8974", "tz": "Asia/Baku", "UTCOffset": "+04:00", "UTCDSTOffset": "+04:00" },
	{ "code": "TH", "latLon": "11376", "tz": "Asia/Bangkok", "UTCOffset": "+07:00", "UTCDSTOffset": "+07:00" },
	{ "code": "RU", "latLon": "13667", "tz": "Asia/Barnaul", "UTCOffset": "+07:00", "UTCDSTOffset": "+07:00" },
	{ "code": "LB", "latLon": "6883", "tz": "Asia/Beirut", "UTCOffset": "+02:00", "UTCDSTOffset": "+03:00" },
	{ "code": "KG", "latLon": "11690", "tz": "Asia/Bishkek", "UTCOffset": "+06:00", "UTCDSTOffset": "+06:00" },
	{ "code": "BN", "latLon": "11911", "tz": "Asia/Brunei", "UTCOffset": "+08:00", "UTCDSTOffset": "+08:00" },
	{ "code": "RU", "latLon": "16531", "tz": "Asia/Chita", "UTCOffset": "+09:00", "UTCDSTOffset": "+09:00" },
	{ "code": "MN", "latLon": "16234", "tz": "Asia/Choibalsan", "UTCOffset": "+08:00", "UTCDSTOffset": "+08:00" },
	{ "code": "LK", "latLon": "8607", "tz": "Asia/Colombo", "UTCOffset": "+05:30", "UTCDSTOffset": "+05:30" },
	{ "code": "SY", "latLon": "6948", "tz": "Asia/Damascus", "UTCOffset": "+02:00", "UTCDSTOffset": "+03:00" },
	{ "code": "BD", "latLon": "11368", "tz": "Asia/Dhaka", "UTCOffset": "+06:00", "UTCDSTOffset": "+06:00" },
	{ "code": "TL", "latLon": "-0833+12535", "tz": "Asia/Dili", "UTCOffset": "+09:00", "UTCDSTOffset": "+09:00" },
	{ "code": "AE", "latLon": "8036", "tz": "Asia/Dubai", "UTCOffset": "+04:00", "UTCDSTOffset": "+04:00" },
	{ "code": "TJ", "latLon": "10683", "tz": "Asia/Dushanbe", "UTCOffset": "+05:00", "UTCDSTOffset": "+05:00" },
	{ "code": "CY", "latLon": "6864", "tz": "Asia/Famagusta", "UTCOffset": "+02:00", "UTCDSTOffset": "+02:00" },
	{ "code": "PS", "latLon": "6558", "tz": "Asia/Gaza", "UTCOffset": "+02:00", "UTCDSTOffset": "+03:00" },
	{ "code": "PS", "latLon": "353674", "tz": "Asia/Hebron", "UTCOffset": "+02:00", "UTCDSTOffset": "+03:00" },
	{ "code": "VN", "latLon": "11685", "tz": "Asia/Ho_Chi_Minh", "UTCOffset": "+07:00", "UTCDSTOffset": "+07:00" },
	{ "code": "HK", "latLon": "13626", "tz": "Asia/Hong_Kong", "UTCOffset": "+08:00", "UTCDSTOffset": "+08:00" },
	{ "code": "MN", "latLon": "13940", "tz": "Asia/Hovd", "UTCOffset": "+07:00", "UTCDSTOffset": "+07:00" },
	{ "code": "RU", "latLon": "15636", "tz": "Asia/Irkutsk", "UTCOffset": "+08:00", "UTCDSTOffset": "+08:00" },
	{ "code": "ID", "latLon": "-0610+10648", "tz": "Asia/Jakarta", "UTCOffset": "+07:00", "UTCDSTOffset": "+07:00" },
	{ "code": "ID", "latLon": "-0232+14042", "tz": "Asia/Jayapura", "UTCOffset": "+09:00", "UTCDSTOffset": "+09:00" },
	{ "code": "IL", "latLon": "665976", "tz": "Asia/Jerusalem", "UTCOffset": "+02:00", "UTCDSTOffset": "+03:00" },
	{ "code": "AF", "latLon": "10343", "tz": "Asia/Kabul", "UTCOffset": "+04:30", "UTCDSTOffset": "+04:30" },
	{ "code": "RU", "latLon": "21140", "tz": "Asia/Kamchatka", "UTCOffset": "+12:00", "UTCDSTOffset": "+12:00" },
	{ "code": "PK", "latLon": "9155", "tz": "Asia/Karachi", "UTCOffset": "+05:00", "UTCDSTOffset": "+05:00" },
	{ "code": "NP", "latLon": "11262", "tz": "Asia/Kathmandu", "UTCOffset": "+05:45", "UTCDSTOffset": "+05:45" },
	{ "code": "RU", "latLon": "1977237", "tz": "Asia/Khandyga", "UTCOffset": "+09:00", "UTCDSTOffset": "+09:00" },
	{ "code": "IN", "latLon": "11054", "tz": "Asia/Kolkata", "UTCOffset": "+05:30", "UTCDSTOffset": "+05:30" },
	{ "code": "RU", "latLon": "14851", "tz": "Asia/Krasnoyarsk", "UTCOffset": "+07:00", "UTCDSTOffset": "+07:00" },
	{ "code": "MY", "latLon": "10452", "tz": "Asia/Kuala_Lumpur", "UTCOffset": "+08:00", "UTCDSTOffset": "+08:00" },
	{ "code": "MY", "latLon": "11153", "tz": "Asia/Kuching", "UTCOffset": "+08:00", "UTCDSTOffset": "+08:00" },
	{ "code": "MO", "latLon": "13549", "tz": "Asia/Macau", "UTCOffset": "+08:00", "UTCDSTOffset": "+08:00" },
	{ "code": "RU", "latLon": "20982", "tz": "Asia/Magadan", "UTCOffset": "+11:00", "UTCDSTOffset": "+11:00" },
	{ "code": "ID", "latLon": "-0507+11924", "tz": "Asia/Makassar", "UTCOffset": "+08:00", "UTCDSTOffset": "+08:00" },
	{ "code": "PH", "latLon": "13535", "tz": "Asia/Manila", "UTCOffset": "+08:00", "UTCDSTOffset": "+08:00" },
	{ "code": "RU", "latLon": "14052", "tz": "Asia/Novokuznetsk", "UTCOffset": "+07:00", "UTCDSTOffset": "+07:00" },
	{ "code": "RU", "latLon": "13757", "tz": "Asia/Novosibirsk", "UTCOffset": "+07:00", "UTCDSTOffset": "+07:00" },
	{ "code": "RU", "latLon": "12824", "tz": "Asia/Omsk", "UTCOffset": "+06:00", "UTCDSTOffset": "+06:00" },
	{ "code": "KZ", "latLon": "10234", "tz": "Asia/Oral", "UTCOffset": "+05:00", "UTCDSTOffset": "+05:00" },
	{ "code": "ID", "latLon": "-0002+10920", "tz": "Asia/Pontianak", "UTCOffset": "+07:00", "UTCDSTOffset": "+07:00" },
	{ "code": "KP", "latLon": "16446", "tz": "Asia/Pyongyang", "UTCOffset": "+09:00", "UTCDSTOffset": "+09:00" },
	{ "code": "QA", "latLon": "7649", "tz": "Asia/Qatar", "UTCOffset": "+03:00", "UTCDSTOffset": "+03:00" },
	{ "code": "KZ", "latLon": "10976", "tz": "Asia/Qyzylorda", "UTCOffset": "+05:00", "UTCDSTOffset": "+05:00" },
	{ "code": "SA", "latLon": "7081", "tz": "Asia/Riyadh", "UTCOffset": "+03:00", "UTCDSTOffset": "+03:00" },
	{ "code": "RU", "latLon": "18900", "tz": "Asia/Sakhalin", "UTCOffset": "+11:00", "UTCDSTOffset": "+11:00" },
	{ "code": "UZ", "latLon": "10588", "tz": "Asia/Samarkand", "UTCOffset": "+05:00", "UTCDSTOffset": "+05:00" },
	{ "code": "KR", "latLon": "16391", "tz": "Asia/Seoul", "UTCOffset": "+09:00", "UTCDSTOffset": "+09:00" },
	{ "code": "CN", "latLon": "15242", "tz": "Asia/Shanghai", "UTCOffset": "+08:00", "UTCDSTOffset": "+08:00" },
	{ "code": "SG", "latLon": "10468", "tz": "Asia/Singapore", "UTCOffset": "+08:00", "UTCDSTOffset": "+08:00" },
	{ "code": "RU", "latLon": "22071", "tz": "Asia/Srednekolymsk", "UTCOffset": "+11:00", "UTCDSTOffset": "+11:00" },
	{ "code": "TW", "latLon": "14633", "tz": "Asia/Taipei", "UTCOffset": "+08:00", "UTCDSTOffset": "+08:00" },
	{ "code": "UZ", "latLon": "11038", "tz": "Asia/Tashkent", "UTCOffset": "+05:00", "UTCDSTOffset": "+05:00" },
	{ "code": "GE", "latLon": "8592", "tz": "Asia/Tbilisi", "UTCOffset": "+04:00", "UTCDSTOffset": "+04:00" },
	{ "code": "IR", "latLon": "8666", "tz": "Asia/Tehran", "UTCOffset": "+03:30", "UTCDSTOffset": "+04:30" },
	{ "code": "BT", "latLon": "11667", "tz": "Asia/Thimphu", "UTCOffset": "+06:00", "UTCDSTOffset": "+06:00" },
	{ "code": "JP", "latLon": "1748357", "tz": "Asia/Tokyo", "UTCOffset": "+09:00", "UTCDSTOffset": "+09:00" },
	{ "code": "RU", "latLon": "14088", "tz": "Asia/Tomsk", "UTCOffset": "+07:00", "UTCDSTOffset": "+07:00" },
	{ "code": "MN", "latLon": "15408", "tz": "Asia/Ulaanbaatar", "UTCOffset": "+08:00", "UTCDSTOffset": "+08:00" },
	{ "code": "CN", "latLon": "13083", "tz": "Asia/Urumqi", "UTCOffset": "+06:00", "UTCDSTOffset": "+06:00" },
	{ "code": "RU", "latLon": "2074673", "tz": "Asia/Ust-Nera", "UTCOffset": "+10:00", "UTCDSTOffset": "+10:00" },
	{ "code": "RU", "latLon": "17466", "tz": "Asia/Vladivostok", "UTCOffset": "+10:00", "UTCDSTOffset": "+10:00" },
	{ "code": "RU", "latLon": "19140", "tz": "Asia/Yakutsk", "UTCOffset": "+09:00", "UTCDSTOffset": "+09:00" },
	{ "code": "MM", "latLon": "11257", "tz": "Asia/Yangon", "UTCOffset": "+06:30", "UTCDSTOffset": "+06:30" },
	{ "code": "RU", "latLon": "11687", "tz": "Asia/Yekaterinburg", "UTCOffset": "+05:00", "UTCDSTOffset": "+05:00" },
	{ "code": "AM", "latLon": "8441", "tz": "Asia/Yerevan", "UTCOffset": "+04:00", "UTCDSTOffset": "+04:00" },
	{ "code": "PT", "latLon": "+3744-02540", "tz": "Atlantic/Azores", "UTCOffset": "-01:00", "UTCDSTOffset": "+00:00" },
	{ "code": "BM", "latLon": "+3217-06446", "tz": "Atlantic/Bermuda", "UTCOffset": "-04:00", "UTCDSTOffset": "-03:00" },
	{ "code": "ES", "latLon": "+2806-01524", "tz": "Atlantic/Canary", "UTCOffset": "+00:00", "UTCDSTOffset": "+01:00" },
	{ "code": "CV", "latLon": "+1455-02331", "tz": "Atlantic/Cape_Verde", "UTCOffset": "-01:00", "UTCDSTOffset": "-01:00" },
	{ "code": "FO", "latLon": "+6201-00646", "tz": "Atlantic/Faroe", "UTCOffset": "+00:00", "UTCDSTOffset": "+01:00" },
	{ "code": "PT", "latLon": "+3238-01654", "tz": "Atlantic/Madeira", "UTCOffset": "+00:00", "UTCDSTOffset": "+01:00" },
	{ "code": "IS", "latLon": "+6409-02151", "tz": "Atlantic/Reykjavik", "UTCOffset": "+00:00", "UTCDSTOffset": "+00:00" },
	{ "code": "GS", "latLon": "-5416-03632", "tz": "Atlantic/South_Georgia", "UTCOffset": "-02:00", "UTCDSTOffset": "-02:00" },
	{ "code": "FK", "latLon": "-5142-05751", "tz": "Atlantic/Stanley", "UTCOffset": "-03:00", "UTCDSTOffset": "-03:00" },
	{ "code": "AU", "latLon": "-3455+13835", "tz": "Australia/Adelaide", "UTCOffset": "+09:30", "UTCDSTOffset": "+10:30" },
	{ "code": "AU", "latLon": "-2728+15302", "tz": "Australia/Brisbane", "UTCOffset": "+10:00", "UTCDSTOffset": "+10:00" },
	{ "code": "AU", "latLon": "-3157+14127", "tz": "Australia/Broken_Hill", "UTCOffset": "+09:30", "UTCDSTOffset": "+10:30" },
	{ "code": "AU", "latLon": "-3956+14352", "tz": "Australia/Currie", "UTCOffset": "+10:00", "UTCDSTOffset": "+11:00" },
	{ "code": "AU", "latLon": "-1228+13050", "tz": "Australia/Darwin", "UTCOffset": "+09:30", "UTCDSTOffset": "+09:30" },
	{ "code": "AU", "latLon": "-3143+12852", "tz": "Australia/Eucla", "UTCOffset": "+08:45", "UTCDSTOffset": "+08:45" },
	{ "code": "AU", "latLon": "-4253+14719", "tz": "Australia/Hobart", "UTCOffset": "+10:00", "UTCDSTOffset": "+11:00" },
	{ "code": "AU", "latLon": "-2016+14900", "tz": "Australia/Lindeman", "UTCOffset": "+10:00", "UTCDSTOffset": "+10:00" },
	{ "code": "AU", "latLon": "-3133+15905", "tz": "Australia/Lord_Howe", "UTCOffset": "+10:30", "UTCDSTOffset": "+11:00" },
	{ "code": "AU", "latLon": "-3749+14458", "tz": "Australia/Melbourne", "UTCOffset": "+10:00", "UTCDSTOffset": "+11:00" },
	{ "code": "AU", "latLon": "-3157+11551", "tz": "Australia/Perth", "UTCOffset": "+08:00", "UTCDSTOffset": "+08:00" },
	{ "code": "AU", "latLon": "-3352+15113", "tz": "Australia/Sydney", "UTCOffset": "+10:00", "UTCDSTOffset": "+11:00" },
	{ "code": "NL", "latLon": "5676", "tz": "Europe/Amsterdam", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "AD", "latLon": "4361", "tz": "Europe/Andorra", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "RU", "latLon": "9424", "tz": "Europe/Astrakhan", "UTCOffset": "+04:00", "UTCDSTOffset": "+04:00" },
	{ "code": "GR", "latLon": "6101", "tz": "Europe/Athens", "UTCOffset": "+02:00", "UTCDSTOffset": "+03:00" },
	{ "code": "RS", "latLon": "6480", "tz": "Europe/Belgrade", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "DE", "latLon": "6552", "tz": "Europe/Berlin", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "BE", "latLon": "5470", "tz": "Europe/Brussels", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "RO", "latLon": "7032", "tz": "Europe/Bucharest", "UTCOffset": "+02:00", "UTCDSTOffset": "+03:00" },
	{ "code": "HU", "latLon": "6635", "tz": "Europe/Budapest", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "MD", "latLon": "7550", "tz": "Europe/Chisinau", "UTCOffset": "+02:00", "UTCDSTOffset": "+03:00" },
	{ "code": "DK", "latLon": "6775", "tz": "Europe/Copenhagen", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "IE", "latLon": "+5320-00615", "tz": "Europe/Dublin", "UTCOffset": "+00:00", "UTCDSTOffset": "+01:00" },
	{ "code": "GI", "latLon": "+3608-00521", "tz": "Europe/Gibraltar", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "FI", "latLon": "8468", "tz": "Europe/Helsinki", "UTCOffset": "+02:00", "UTCDSTOffset": "+03:00" },
	{ "code": "TR", "latLon": "6959", "tz": "Europe/Istanbul", "UTCOffset": "+03:00", "UTCDSTOffset": "+03:00" },
	{ "code": "RU", "latLon": "7473", "tz": "Europe/Kaliningrad", "UTCOffset": "+02:00", "UTCDSTOffset": "+02:00" },
	{ "code": "UA", "latLon": "8057", "tz": "Europe/Kiev", "UTCOffset": "+02:00", "UTCDSTOffset": "+03:00" },
	{ "code": "RU", "latLon": "10775", "tz": "Europe/Kirov", "UTCOffset": "+03:00", "UTCDSTOffset": "+03:00" },
	{ "code": "PT", "latLon": "+3843-00908", "tz": "Europe/Lisbon", "UTCOffset": "+00:00", "UTCDSTOffset": "+01:00" },
	{ "code": "GB", "latLon": "+513030-0000731", "tz": "Europe/London", "UTCOffset": "+00:00", "UTCDSTOffset": "+01:00" },
	{ "code": "LU", "latLon": "5545", "tz": "Europe/Luxembourg", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "ES", "latLon": "+4024-00341", "tz": "Europe/Madrid", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "MT", "latLon": "4985", "tz": "Europe/Malta", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "BY", "latLon": "8088", "tz": "Europe/Minsk", "UTCOffset": "+03:00", "UTCDSTOffset": "+03:00" },
	{ "code": "MC", "latLon": "5065", "tz": "Europe/Monaco", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "RU", "latLon": "928225", "tz": "Europe/Moscow", "UTCOffset": "+03:00", "UTCDSTOffset": "+03:00" },
	{ "code": "CY", "latLon": "6832", "tz": "Asia/Nicosia", "UTCOffset": "+02:00", "UTCDSTOffset": "+03:00" },
	{ "code": "NO", "latLon": "7000", "tz": "Europe/Oslo", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "FR", "latLon": "5072", "tz": "Europe/Paris", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "CZ", "latLon": "6431", "tz": "Europe/Prague", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "LV", "latLon": "8063", "tz": "Europe/Riga", "UTCOffset": "+02:00", "UTCDSTOffset": "+03:00" },
	{ "code": "IT", "latLon": "5383", "tz": "Europe/Rome", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "RU", "latLon": "10321", "tz": "Europe/Samara", "UTCOffset": "+04:00", "UTCDSTOffset": "+04:00" },
	{ "code": "RU", "latLon": "9736", "tz": "Europe/Saratov", "UTCOffset": "+04:00", "UTCDSTOffset": "+04:00" },
	{ "code": "UA", "latLon": "7863", "tz": "Europe/Simferopol", "UTCOffset": "+03:00", "UTCDSTOffset": "+03:00" },
	{ "code": "BG", "latLon": "6560", "tz": "Europe/Sofia", "UTCOffset": "+02:00", "UTCDSTOffset": "+03:00" },
	{ "code": "SE", "latLon": "7723", "tz": "Europe/Stockholm", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "EE", "latLon": "8370", "tz": "Europe/Tallinn", "UTCOffset": "+02:00", "UTCDSTOffset": "+03:00" },
	{ "code": "AL", "latLon": "6070", "tz": "Europe/Tirane", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "RU", "latLon": "10244", "tz": "Europe/Ulyanovsk", "UTCOffset": "+04:00", "UTCDSTOffset": "+04:00" },
	{ "code": "UA", "latLon": "7055", "tz": "Europe/Uzhgorod", "UTCOffset": "+02:00", "UTCDSTOffset": "+03:00" },
	{ "code": "AT", "latLon": "6433", "tz": "Europe/Vienna", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "LT", "latLon": "7960", "tz": "Europe/Vilnius", "UTCOffset": "+02:00", "UTCDSTOffset": "+03:00" },
	{ "code": "RU", "latLon": "9269", "tz": "Europe/Volgograd", "UTCOffset": "+04:00", "UTCDSTOffset": "+04:00" },
	{ "code": "PL", "latLon": "7315", "tz": "Europe/Warsaw", "UTCOffset": "+02:00", "UTCDSTOffset": "+03:00" },
	{ "code": "UA", "latLon": "8260", "tz": "Europe/Zaporozhye", "UTCOffset": "+02:00", "UTCDSTOffset": "+03:00" },
	{ "code": "CH", "latLon": "5555", "tz": "Europe/Zurich", "UTCOffset": "+01:00", "UTCDSTOffset": "+02:00" },
	{ "code": "IO", "latLon": "-0720+07225", "tz": "Indian/Chagos", "UTCOffset": "+06:00", "UTCDSTOffset": "+06:00" },
	{ "code": "CX", "latLon": "-1025+10543", "tz": "Indian/Christmas", "UTCOffset": "+07:00", "UTCDSTOffset": "+07:00" },
	{ "code": "CC", "latLon": "-1210+09655", "tz": "Indian/Cocos", "UTCOffset": "+06:30", "UTCDSTOffset": "+06:30" },
	{ "code": "TF", "latLon": "-492110+0701303", "tz": "Indian/Kerguelen", "UTCOffset": "+05:00", "UTCDSTOffset": "+05:00" },
	{ "code": "SC", "latLon": "-0440+05528", "tz": "Indian/Mahe", "UTCOffset": "+04:00", "UTCDSTOffset": "+04:00" },
	{ "code": "MV", "latLon": "7740", "tz": "Indian/Maldives", "UTCOffset": "+05:00", "UTCDSTOffset": "+05:00" },
	{ "code": "MU", "latLon": "-2010+05730", "tz": "Indian/Mauritius", "UTCOffset": "+04:00", "UTCDSTOffset": "+04:00" },
	{ "code": "RE", "latLon": "-2052+05528", "tz": "Indian/Reunion", "UTCOffset": "+04:00", "UTCDSTOffset": "+04:00" },
	{ "code": "WS", "latLon": "-1350-17144", "tz": "Pacific/Apia", "UTCOffset": "+13:00", "UTCDSTOffset": "+14:00" },
	{ "code": "NZ", "latLon": "-3652+17446", "tz": "Pacific/Auckland", "UTCOffset": "+12:00", "UTCDSTOffset": "+13:00" },
	{ "code": "PG", "latLon": "-0613+15534", "tz": "Pacific/Bougainville", "UTCOffset": "+11:00", "UTCDSTOffset": "+11:00" },
	{ "code": "NZ", "latLon": "-4357-17633", "tz": "Pacific/Chatham", "UTCOffset": "+12:45", "UTCDSTOffset": "+13:45" },
	{ "code": "FM", "latLon": "15872", "tz": "Pacific/Chuuk", "UTCOffset": "+10:00", "UTCDSTOffset": "+10:00" },
	{ "code": "CL", "latLon": "-2709-10926", "tz": "Pacific/Easter", "UTCOffset": "-06:00", "UTCDSTOffset": "-05:00" },
	{ "code": "VU", "latLon": "-1740+16825", "tz": "Pacific/Efate", "UTCOffset": "+11:00", "UTCDSTOffset": "+11:00" },
	{ "code": "KI", "latLon": "-0308-17105", "tz": "Pacific/Enderbury", "UTCOffset": "+13:00", "UTCDSTOffset": "+13:00" },
	{ "code": "TK", "latLon": "-0922-17114", "tz": "Pacific/Fakaofo", "UTCOffset": "+13:00", "UTCDSTOffset": "+13:00" },
	{ "code": "FJ", "latLon": "-1808+17825", "tz": "Pacific/Fiji", "UTCOffset": "+12:00", "UTCDSTOffset": "+13:00" },
	{ "code": "TV", "latLon": "-0831+17913", "tz": "Pacific/Funafuti", "UTCOffset": "+12:00", "UTCDSTOffset": "+12:00" },
	{ "code": "EC", "latLon": "-0054-08936", "tz": "Pacific/Galapagos", "UTCOffset": "-06:00", "UTCDSTOffset": "-06:00" },
	{ "code": "PF", "latLon": "-2308-13457", "tz": "Pacific/Gambier", "UTCOffset": "-09:00", "UTCDSTOffset": "-09:00" },
	{ "code": "SB", "latLon": "-0932+16012", "tz": "Pacific/Guadalcanal", "UTCOffset": "+11:00", "UTCDSTOffset": "+11:00" },
	{ "code": "GU", "latLon": "15773", "tz": "Pacific/Guam", "UTCOffset": "+10:00", "UTCDSTOffset": "+10:00" },
	{ "code": "US", "latLon": "+211825-1575130", "tz": "Pacific/Honolulu", "UTCOffset": "-10:00", "UTCDSTOffset": "-10:00" },
	{ "code": "KI", "latLon": "+0152-15720", "tz": "Pacific/Kiritimati", "UTCOffset": "+14:00", "UTCDSTOffset": "+14:00" },
	{ "code": "FM", "latLon": "16778", "tz": "Pacific/Kosrae", "UTCOffset": "+11:00", "UTCDSTOffset": "+11:00" },
	{ "code": "MH", "latLon": "17625", "tz": "Pacific/Kwajalein", "UTCOffset": "+12:00", "UTCDSTOffset": "+12:00" },
	{ "code": "MH", "latLon": "17821", "tz": "Pacific/Majuro", "UTCOffset": "+12:00", "UTCDSTOffset": "+12:00" },
	{ "code": "PF", "latLon": "-0900-13930", "tz": "Pacific/Marquesas", "UTCOffset": "-09:30", "UTCDSTOffset": "-09:30" },
	{ "code": "NR", "latLon": "-0031+16655", "tz": "Pacific/Nauru", "UTCOffset": "+12:00", "UTCDSTOffset": "+12:00" },
	{ "code": "NU", "latLon": "-1901-16955", "tz": "Pacific/Niue", "UTCOffset": "-11:00", "UTCDSTOffset": "-11:00" },
	{ "code": "NF", "latLon": "-2903+16758", "tz": "Pacific/Norfolk", "UTCOffset": "+11:00", "UTCDSTOffset": "+11:00" },
	{ "code": "NC", "latLon": "-2216+16627", "tz": "Pacific/Noumea", "UTCOffset": "+11:00", "UTCDSTOffset": "+11:00" },
	{ "code": "AS", "latLon": "-1416-17042", "tz": "Pacific/Pago_Pago", "UTCOffset": "-11:00", "UTCDSTOffset": "-11:00" },
	{ "code": "PW", "latLon": "14149", "tz": "Pacific/Palau", "UTCOffset": "+09:00", "UTCDSTOffset": "+09:00" },
	{ "code": "PN", "latLon": "-2504-13005", "tz": "Pacific/Pitcairn", "UTCOffset": "-08:00", "UTCDSTOffset": "-08:00" },
	{ "code": "FM", "latLon": "16471", "tz": "Pacific/Pohnpei", "UTCOffset": "+11:00", "UTCDSTOffset": "+11:00" },
	{ "code": "PG", "latLon": "-0930+14710", "tz": "Pacific/Port_Moresby", "UTCOffset": "+10:00", "UTCDSTOffset": "+10:00" },
	{ "code": "CK", "latLon": "-2114-15946", "tz": "Pacific/Rarotonga", "UTCOffset": "-10:00", "UTCDSTOffset": "-10:00" },
	{ "code": "PF", "latLon": "-1732-14934", "tz": "Pacific/Tahiti", "UTCOffset": "-10:00", "UTCDSTOffset": "-10:00" },
	{ "code": "KI", "latLon": "17425", "tz": "Pacific/Tarawa", "UTCOffset": "+12:00", "UTCDSTOffset": "+12:00" },
	{ "code": "TO", "latLon": "-2110-17510", "tz": "Pacific/Tongatapu", "UTCOffset": "+13:00", "UTCDSTOffset": "+14:00" },
	{ "code": "UM", "latLon": "18554", "tz": "Pacific/Wake", "UTCOffset": "+12:00", "UTCDSTOffset": "+12:00" },
	{ "code": "WF", "latLon": "-1318-17610", "tz": "Pacific/Wallis", "UTCOffset": "+12:00", "UTCDSTOffset": "+12:00" },
]