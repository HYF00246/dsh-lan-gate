import assert from "node:assert/strict"
import { Readable } from "node:stream"
import test from "node:test"

import { registerRoutes, STATE_PATH, TOGGLE_PATH, WIDGET_PATH } from "../lib/routes.js"

const CONFIG = { listenHost: "192.168.137.1", port: 18080 }
const LOOPBACK = { host: "127.0.0.1:54362" }

/**
 * 假的 webServer：记录注册的路由。
 * @returns {{ ctx: object, routes: Map<string, object> }}
 */
function makeContext() {
	const routes = new Map()
	const ctx = {
		webServer: {
			register(route) {
				routes.set(route.path, route)
				return () => routes.delete(route.path)
			},
		},
	}
	return { ctx, routes }
}

/**
 * 假的响应对象。
 * @returns {object}
 */
function makeResponse() {
	return {
		statusCode: 0,
		headers: {},
		body: "",
		ended: false,
		writeHead(code, headers = {}) {
			this.statusCode = code
			Object.assign(this.headers, headers)
		},
		end(chunk) {
			if (chunk !== undefined) this.body += String(chunk)
			this.ended = true
		},
	}
}

/**
 * 假的请求对象。
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [options] - 请求参数。
 * @returns {object}
 */
function makeRequest(options = {}) {
	const stream = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)])
	stream.method = options.method ?? "GET"
	stream.headers = options.headers ?? LOOPBACK
	return stream
}

const gate = {
	status: () => ({ state: "off", enabled: false, address: "192.168.137.1:18080", error: null }),
	async toggle(enabled) {
		return { state: enabled ? "on" : "off", enabled, address: "192.168.137.1:18080", error: null }
	},
}

test("注册三条路由，且可注销", () => {
	const { ctx, routes } = makeContext()
	const disposers = registerRoutes(ctx, { gate, config: CONFIG })
	assert.deepEqual([...routes.keys()].sort(), [STATE_PATH, TOGGLE_PATH, WIDGET_PATH].sort())
	for (const dispose of disposers) dispose()
	assert.equal(routes.size, 0)
})

test("GET /__lan_gate/state 返回开关状态", async () => {
	const { ctx, routes } = makeContext()
	registerRoutes(ctx, { gate, config: CONFIG })
	const res = makeResponse()
	await routes.get(STATE_PATH).handler(makeRequest(), res)
	assert.equal(res.statusCode, 200)
	assert.match(String(res.headers["content-type"]), /application\/json/u)
	assert.deepEqual(JSON.parse(res.body), { state: "off", enabled: false, address: "192.168.137.1:18080", error: null })
})

test("GET /__lan_gate/state 对跨站请求返回 403", async () => {
	const { ctx, routes } = makeContext()
	registerRoutes(ctx, { gate, config: CONFIG })
	const res = makeResponse()
	await routes.get(STATE_PATH).handler(
		makeRequest({ headers: { host: "127.0.0.1:54362", "sec-fetch-site": "cross-site" } }),
		res,
	)
	assert.equal(res.statusCode, 403)
})

test("POST /__lan_gate/toggle 按请求体切换", async () => {
	const { ctx, routes } = makeContext()
	registerRoutes(ctx, { gate, config: CONFIG })
	const res = makeResponse()
	await routes.get(TOGGLE_PATH).handler(
		makeRequest({ method: "POST", body: JSON.stringify({ enabled: true }) }),
		res,
	)
	assert.equal(res.statusCode, 200)
	assert.equal(JSON.parse(res.body).enabled, true)
})

test("POST /__lan_gate/toggle 省略 enabled 时取反", async () => {
	const { ctx, routes } = makeContext()
	registerRoutes(ctx, { gate, config: CONFIG })
	const res = makeResponse()
	await routes.get(TOGGLE_PATH).handler(makeRequest({ method: "POST", body: "{}" }), res)
	assert.equal(res.statusCode, 200)
	assert.equal(JSON.parse(res.body).enabled, true, "当前是关，取反应为开")
})

test("POST /__lan_gate/toggle 拒绝非 POST 与坏 JSON", async () => {
	const { ctx, routes } = makeContext()
	registerRoutes(ctx, { gate, config: CONFIG })

	const wrongMethod = makeResponse()
	await routes.get(TOGGLE_PATH).handler(makeRequest({ method: "GET" }), wrongMethod)
	assert.equal(wrongMethod.statusCode, 405)

	const badJson = makeResponse()
	await routes.get(TOGGLE_PATH).handler(makeRequest({ method: "POST", body: "{oops" }), badJson)
	assert.equal(badJson.statusCode, 400)
})

test("GET /__lan_gate/widget.js 返回开关脚本", async () => {
	const { ctx, routes } = makeContext()
	registerRoutes(ctx, { gate, config: CONFIG })
	const res = makeResponse()
	await routes.get(WIDGET_PATH).handler(makeRequest(), res)
	assert.equal(res.statusCode, 200)
	assert.match(String(res.headers["content-type"]), /javascript/u)
	assert.match(res.body, /__dshLanGateWidget/u)
	assert.match(res.body, /__lan_gate\/toggle/u)
})
