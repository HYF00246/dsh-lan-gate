import assert from "node:assert/strict"
import { Readable } from "node:stream"
import test from "node:test"

import { apply, name, normalizeConfig } from "../lib/index.js"

/**
 * 造一个假的 Cordis 上下文：捕获事件订阅、effect、注入与路由注册。
 * @param {object} services - 交给 `ctx.inject` 回调的服务。
 * @returns {object} 假上下文与观察点。
 */
function makeFakeContext(services) {
	const listeners = new Map()
	const routes = new Map()
	/** @type {Function[]} */
	const disposers = []

	/**
	 * 创建带服务的子上下文。
	 * @param {object} provided - 服务。
	 * @returns {object} 子上下文。
	 */
	function scoped(provided) {
		return {
			...provided,
			effect(execute) {
				const dispose = execute()
				disposers.push(dispose)
				return dispose
			},
		}
	}

	const ctx = {
		effect(execute) {
			const dispose = execute()
			disposers.push(dispose)
			return dispose
		},
		on(event, listener) {
			const set = listeners.get(event) ?? new Set()
			set.add(listener)
			listeners.set(event, set)
			return () => set.delete(listener)
		},
		inject(_deps, callback) {
			callback(scoped(services))
		},
	}

	return {
		ctx,
		listeners,
		routes,
		disposers,
		/**
		 * 模拟宿主收集注入表。
		 * @param {object[]} table - 注入表。
		 * @returns {object[]}
		 */
		collect(table) {
			for (const listener of listeners.get("webserver/index-inject") ?? []) listener(table)
			return table
		},
	}
}

/**
 * 造一个假的 webServer 服务。
 * @param {object} routes - 路由表。
 * @returns {object}
 */
function makeWebServer(routes) {
	return {
		getOrigin: () => "http://127.0.0.1:54362",
		register(route) {
			routes.set(route.path, route)
			return () => routes.delete(route.path)
		},
	}
}

/** @returns {object} 假的请求/响应基座。 */
function makeRequest({ method = "GET", headers = { host: "127.0.0.1:54362" }, body } = {}) {
	const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)])
	stream.method = method
	stream.headers = headers
	return stream
}

/** @returns {object} 假的响应。 */
function makeResponse() {
	return {
		statusCode: 0,
		headers: {},
		body: "",
		writeHead(code, headers = {}) {
			this.statusCode = code
			Object.assign(this.headers, headers)
		},
		end(chunk) {
			if (chunk !== undefined) this.body += String(chunk)
		},
	}
}

test("插件导出名与默认配置", () => {
	assert.equal(name, "lan-gate")
	assert.deepEqual(normalizeConfig({}), { listenHost: "192.168.137.1", port: 18080, widget: true })
	assert.deepEqual(normalizeConfig({ port: 9999, widget: false }), { listenHost: "192.168.137.1", port: 9999, widget: false })
	assert.throws(() => normalizeConfig({ port: 0 }), /1-65535/u)
	assert.throws(() => normalizeConfig({ port: "abc" }), /1-65535/u)
})

test("apply() 注册注入行、三条路由，并能真正开关监听", async () => {
	const services = {}
	const fake = makeFakeContext(services)
	services.webServer = makeWebServer(fake.routes)
	services.connection = { authenticatedUrl: (base) => `${base}?token=test` }

	apply(fake.ctx, { listenHost: "127.0.0.1", port: 18081, widget: true })

	// ① 注入行：去重生效
	const table = []
	fake.collect(table)
	fake.collect(table)
	assert.equal(table.length, 1, "重复收集不应重复插入")
	assert.equal(table[0].kind, "script")
	assert.equal(table[0].placement, "body")
	assert.match(table[0].text, /\/__lan_gate\/widget\.js/u)
	assert.match(table[0].text, /onerror=function\(\)\{\}/u)

	// ② 三条路由
	assert.deepEqual(
		[...fake.routes.keys()].sort(),
		["/__lan_gate/state", "/__lan_gate/toggle", "/__lan_gate/widget.js"],
	)

	// ③ 通过路由真正打开监听
	const onRes = makeResponse()
	await fake.routes.get("/__lan_gate/toggle").handler(
		makeRequest({ method: "POST", body: JSON.stringify({ enabled: true }) }),
		onRes,
	)
	assert.equal(onRes.statusCode, 200)
	const onState = JSON.parse(onRes.body)
	assert.equal(onState.enabled, true)
	assert.equal(onState.address, "127.0.0.1:18081")

	const stateRes = makeResponse()
	await fake.routes.get("/__lan_gate/state").handler(makeRequest(), stateRes)
	assert.equal(JSON.parse(stateRes.body).enabled, true)

	// ④ 关闭
	const offRes = makeResponse()
	await fake.routes.get("/__lan_gate/toggle").handler(
		makeRequest({ method: "POST", body: JSON.stringify({ enabled: false }) }),
		offRes,
	)
	assert.equal(JSON.parse(offRes.body).enabled, false)

	// ⑤ 卸载：disposer 全部可执行且不抛错
	for (const dispose of fake.disposers.reverse()) {
		if (typeof dispose === "function") await dispose()
	}
})

test("widget=false 时不注册注入行", () => {
	const fake = makeFakeContext({ webServer: makeWebServer(new Map()), connection: {} })
	apply(fake.ctx, { listenHost: "127.0.0.1", port: 18082, widget: false })
	const table = []
	fake.collect(table)
	assert.equal(table.length, 0)
})
