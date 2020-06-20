const CONFIG = require("./config.json");
const https = require("https");
const fs = require("fs");
const url = require("url");
const redis = require("redis");

const options = {
	"key": fs.readFileSync(CONFIG.key),
	"cert": fs.readFileSync(CONFIG.cert),
	"ca": fs.readFileSync(CONFIG.ca)
};

const client = redis.createClient();

function getNextMidnightOfPST() {
	return new Date(((new Date().setHours(24, 5, 0, 0) / 1000) + Math.abs(new Date().getTimezoneOffset() * 60) + Math.ceil(-17 * 3600)) * 1000);
}

var apiKeyIndex = 0;
var apiKeyIndexNextReset = getNextMidnightOfPST();

function requestApi(res, redisKey, reqUrl) {
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
					apiKeyIndex++;
					return requestApi(res, redisKey, reqUrl);
				} else if (new Date() > apiKeyIndexNextReset) {
					apiKeyIndex = 0;
					apiKeyIndexNextReset = getNextMidnightOfPST();
					return requestApi(res, redisKey, reqUrl);
				} else {
					res.writeHead(500);
					res.end();
				}
			}
			client.set(redisKey, data, "EX", CONFIG.redisExpire);
			console.log("Data");
			res.writeHead(200, {"Content-Type": "application/json"});
			res.end(data);
		});
	});
	apiReq.end();
}

function searchApi(res, q) {
	const redisKey = "search:"+ q;
	client.get(redisKey, (err, result) => {
		if (result) {
			res.end(result);
		} else {
			requestApi(res, redisKey, "https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults="+ CONFIG.maxSearchResults +"&type=video&videoEmbeddable=true&videoSyndicated=true&q="+ q);
		}
	});
}

function videoApi(res, q) {
	const redisKey = "video:"+ q;
	client.get(redisKey, (err, result) => {
		if (result) {
			res.end(result);
		} else {
			requestApi(res, redisKey, "https://www.googleapis.com/youtube/v3/videos?part=snippet&id="+ q);
		}
	});
}

https.createServer(options, function(req, res) {
	var ip = req.connection.remoteAddress || req.socket.remoteAddress;
	var q = url.parse(req.url, true).query;
	if (! q.q || (q.type !== "search" && q.type !== "video")) {
		res.writeHead(400);
		res.end();
		return;
	}
	if (q.type === "search") {
		console.log("Search: "+ q.q);
		searchApi(res, q.q);
	} else if (q.type === "video") {
		console.log("Videoinfo: "+ q.q);
		videoApi(res, q.q);
	}
}).listen(CONFIG.port, CONFIG.hostname, () => {
	console.log(`Server running at https://${CONFIG.hostname}:${CONFIG.port}/`);
});