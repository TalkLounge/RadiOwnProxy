const CONFIG = require("./config.json");
const https = require("https");
const fs = require("fs");
const url = require("url");
const redis = require("redis");
var pgtools = require("pgtools");
const { Pool } = require("pg");
var { DateTime } = require("luxon");

var errorCodes = [];
errorCodes[0] = "Success";
errorCodes[1] = "Invalid query";
errorCodes[2] = "Too many requests";
errorCodes[3] = "Too many search requests";
errorCodes[4] = "Too many video requests";
errorCodes[5] = "Internal server error";

function throwError(res, errorCode) {
	res.end(JSON.stringify({errorCode: errorCode, errorText: errorCodes[errorCode]}));
}

const LOG = {info: "INFO", error: "Error"}

function log(type, msg, ip) {
	if (ip) {
		msg = ip +": "+ msg
	}
	console.log(new Date().toLocaleString() +": "+ type +": "+ msg);
}

const options = {
	key: fs.readFileSync(CONFIG.key),
	cert: fs.readFileSync(CONFIG.cert),
	ca: fs.readFileSync(CONFIG.ca)
};

const redisClient = redis.createClient();

pgtools.createdb({
	user: CONFIG.postgresUser,
	password: CONFIG.postgresPassword,
	host: CONFIG.postgresHost,
	port: CONFIG.postgresPort,
}, CONFIG.postgresDatabase, (err, res) => {
	if (err && ! err.pgErr) {
		log(LOG.error, err);
		process.exit(-1);
	}
	initTable();
});

const pool = new Pool({
	database: CONFIG.postgresDatabase,
	user: CONFIG.postgresUser,
	password: CONFIG.postgresPassword,
	host: CONFIG.postgresHost,
	port: CONFIG.postgresPort,
	max: CONFIG.postgresMaxConnections
});

function initTable() {
	pool.query(`
		CREATE TABLE IF NOT EXISTS users_ips(
			id SERIAL PRIMARY KEY,
			ip VARCHAR(39) UNIQUE NOT NULL,
			search_requests_count INTEGER DEFAULT 0,
			video_requests_count INTEGER DEFAULT 0,
			requests_count INTEGER DEFAULT 1
		);
		TRUNCATE users_ips RESTART IDENTITY;
	`);
}

function getNextMidnightOfUSPacificTimeZone() {
	return new Date().setHours(24, 5, 0, 0) + ((new Date().getTimezoneOffset() + DateTime.local().setZone("America/Los_Angeles").offset) * 60 * 1000 * -1)
}

var apiKeyIndex = 0;
var apiKeyIndexNextReset = getNextMidnightOfUSPacificTimeZone();

function requestApi(res, redisKey, reqUrl) {
	if (new Date() > apiKeyIndexNextReset) {
		log(LOG.info, "API Key Reset");
		apiKeyIndex = 0;
		apiKeyIndexNextReset = getNextMidnightOfUSPacificTimeZone();
		initTable();
	}
	const requestUrl = reqUrl +"&key="+ CONFIG.apiKeys[apiKeyIndex];
	const apiUrl = new URL(requestUrl);
	const apiReq = https.request(apiUrl, (apiRes) => {
		var data = "";
		apiRes.on("data", (apiData) => {
			data += apiData;
		});
		apiRes.on("end", () => {
			if (JSON.parse(data).error) {
				if (apiKeyIndex + 1 < CONFIG.apiKeys.length) {
					log(LOG.info, "API Key Change");
					apiKeyIndex++;
					return requestApi(res, redisKey, reqUrl);
				} else {
					log(LOG.error, "API Key exceed");
					return throwError(res, 5);
				}
			}
			redisClient.set(redisKey, data, "EX", CONFIG.redisExpire);
			res.end(data);
		});
	});
	apiReq.end();
}

function updateRequestCount(ip, apiRequest) {
	if (apiRequest) {
		pool.query("INSERT INTO users_ips (ip, "+ apiRequest +"_requests_count) VALUES ($1, 1) ON CONFLICT (ip) DO UPDATE SET requests_count = users_ips.requests_count + 1, "+ apiRequest +"_requests_count = users_ips."+ apiRequest +"_requests_count + 1", [ip]);
	} else {
		pool.query("INSERT INTO users_ips (ip) VALUES ($1) ON CONFLICT (ip) DO UPDATE SET requests_count = users_ips.requests_count + 1", [ip]);
	}
}

function searchApi(res, q, ip, data) {
	const redisKey = "search:"+ q;
	redisClient.get(redisKey, (err, result) => {
		if (result) {
			log(LOG.info, "Search Cache - "+ q, ip);
			updateRequestCount(ip);
			res.end(result);
		} else {
			if (data && data.search_requests_count >= CONFIG.SearchLimitPerDay) {
				log(LOG.info, errorCodes[3] +" - Search - "+ q, ip);
				return throwError(res, 3);
			}
			log(LOG.info, "Search - "+ q, ip);
			updateRequestCount(ip, "search");
			requestApi(res, redisKey, "https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults="+ CONFIG.maxSearchResults +"&type=video&videoEmbeddable=true&videoSyndicated=true&q="+ q);
		}
	});
}

function videoApi(res, q, ip, data) {
	const redisKey = "video:"+ q;
	redisClient.get(redisKey, (err, result) => {
		if (result) {
			log(LOG.info, "Video Cache - "+ q, ip);
			updateRequestCount(ip);
			res.end(result);
		} else {
			if (data && data.video_requests_count >= CONFIG.VideoLimitPerDay) {
				log(LOG.info, errorCodes[4] +" - Video - "+ q, ip);
				return throwError(res, 4);
			}
			log(LOG.info, "Video - "+ q, ip);
			updateRequestCount(ip, "video");
			requestApi(res, redisKey, "https://www.googleapis.com/youtube/v3/videos?part=snippet&id="+ q);
		}
	});
}

https.createServer(options, function(req, res) {
	const ip = req.connection.remoteAddress || req.socket.remoteAddress;
	const reqUrl = url.parse(req.url, true);
	if (reqUrl.pathname !== "/") {
		log(LOG.info, "Not found - "+ reqUrl.path, ip);
		res.writeHead(404);
		res.end();
		return;
	}
	const query = reqUrl.query;
	res.writeHead(200, {"Content-Type": "application/json"});
	if ((query.type !== "search" && query.type !== "video" && query.type !== "policy") || (! query.q && (query.type === "search" || query.type === "video"))) {
		log(LOG.info, errorCodes[1] + " - "+ reqUrl.path, ip);
		return throwError(res, 1);
	}
	pool.query("SELECT * FROM users_ips WHERE ip = $1", [ip], (err, data) => {
		if (data.rows[0] && data.rows[0].requests_count >= CONFIG.RequestLimitPerDay) {
			log(LOG.info, errorCodes[2] +" - "+ query.type.charAt(0).toUpperCase() + query.type.slice(1) +" - "+ query.q, ip);
			return throwError(res, 2);
		}
		if (query.type === "search") {
			searchApi(res, query.q, ip, data.rows[0]);
		} else if (query.type === "video") {
			videoApi(res, query.q, ip, data.rows[0]);
		} else if (query.type === "policy") {
			log(LOG.info, "Policy", ip);
			updateRequestCount(ip);
			res.end(JSON.stringify({policy: CONFIG.policyText}));
		}
	});
}).listen(CONFIG.port, CONFIG.hostname, (err, res) => {
	log(LOG.info, `Server running at https://${CONFIG.hostname}:${CONFIG.port}/`);
});