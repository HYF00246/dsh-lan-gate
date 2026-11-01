import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"

import { createGate, describeFailure } from "../lib/gate.js"

const CONFIG = { listenHost: "192.168.137.1", port: 18080 }

/**
 * 造一个假服务器：listen 走一次事件循环后触发 listening（或 error）。
 * @param {{ failWith?: string }} [options] - 失败注入。
 * @returns {{ factory(): object, created: object[] }}
 */
function fakeFactory(options = {}) {
	const created = []
	function factory() {
		const server = new EventEmitter()
		server.listening = false
		server.listen = (port, host) => {
			server.listenArgs = { port, host }
			setImmediate(() => {
				if (options.failWith !== undefined) {
					server.emit("error", Object.assign(new Error(options.failWith), { code: options.failWith }))
					return
				}
				server.listening = true
				server.emit("listening")
			})
		}
		server.close = (callback) => {
			server.listening = false
			if (typeof callback === "function") setImmediate(callback)
		}
		const handle = {
			server,
			close: () => new Promise((resolve) => server.close(resolve)),
		}
		created.push(handle)
		return handle
	}
	return { factory, created }
}

test("默认关闭，打开后在配置的地址监听", async () => {
	const { factory, created } = fakeFactory()
	const gate = createGate({ config: CONFIG, createServer: factory })

	assert.equal(gate.status().state, "off")
	assert.equal(gate.status().enabled, false)

	const on = await gate.toggle(true)
	assert.equal(on.state, "on")
	assert.equal(on.enabled, true)
	assert.equal(on.address, "192.168.137.1:18080")
	assert.equal(created.length, 1)
	assert.deepEqual(created[0].server.listenArgs, { port: 18080, host: "192.168.137.1" })
	assert.equal(created[0].server.listening, true)

	const off = await gate.toggle(false)
	assert.equal(off.state, "off")
	assert.equal(off.enabled, false)
	assert.equal(created[0].server.listening, false)
})

test("热点没开时保持关闭并给出可读原因", async () => {
	const { factory } = fakeFactory({ failWith: "EADDRNOTAVAIL" })
	const gate = createGate({ config: CONFIG, createServer: factory })

	const status = await gate.toggle(true)
	assert.equal(status.state, "off")
	assert.equal(status.enabled, false)
	assert.match(String(status.error), /热点未开启/u)
})

test("失败后可以再次尝试", async () => {
	const { factory } = fakeFactory({ failWith: "EADDRINUSE" })
	const gate = createGate({ config: CONFIG, createServer: factory })

	await gate.toggle(true)
	assert.match(String(gate.status().error), /端口 18080 已被占用/u)

	// 换一个不会失败的工厂，模拟端口被释放
	const retry = fakeFactory()
	const retryGate = createGate({ config: CONFIG, createServer: retry.factory })
	assert.equal((await retryGate.toggle(true)).state, "on")
})

test("并发点击串行化，不会重复监听", async () => {
	const { factory, created } = fakeFactory()
	const gate = createGate({ config: CONFIG, createServer: factory })

	await Promise.all([gate.toggle(true), gate.toggle(true), gate.toggle(true)])
	assert.equal(created.length, 1, "重复的开启只应创建一次服务器")
	assert.equal(gate.status().state, "on")

	await Promise.all([gate.toggle(false), gate.toggle(true)])
	assert.equal(gate.status().state, "on")
})

test("dispose 会关闭监听", async () => {
	const { factory, created } = fakeFactory()
	const gate = createGate({ config: CONFIG, createServer: factory })

	await gate.toggle(true)
	await gate.dispose()
	assert.equal(gate.status().state, "off")
	assert.equal(created[0].server.listening, false)
})

test("describeFailure 把底层错误翻译成用户能懂的话", () => {
	assert.match(describeFailure({ code: "EADDRNOTAVAIL" }, CONFIG), /热点未开启/u)
	assert.match(describeFailure({ code: "EADDRINUSE" }, CONFIG), /端口 18080 已被占用/u)
	assert.match(describeFailure({ code: "EACCES" }, CONFIG), /没有权限/u)
	assert.equal(describeFailure(new Error("boom"), CONFIG), "boom")
	assert.equal(describeFailure("text", CONFIG), "text")
})
