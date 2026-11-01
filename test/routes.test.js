import assert from "node:assert/strict"
import test from "node:test"

import { isTrustedRequest } from "../lib/routes.js"

const CONFIG = { listenHost: "192.168.137.1", port: 18080 }

/** @param {Record<string, string>} headers */
const req = (headers) => ({ headers })

test("回环 Host 视为可信", () => {
	assert.equal(isTrustedRequest(req({ host: "127.0.0.1:54362" }), CONFIG), true)
	assert.equal(isTrustedRequest(req({ host: "127.0.0.1" }), CONFIG), true)
	assert.equal(isTrustedRequest(req({ host: "[::1]:54362" }), CONFIG), true)
	assert.equal(isTrustedRequest(req({ host: "localhost:54362" }), CONFIG), true)
})

test("本插件自己的监听地址也可信（手机经代理访问时）", () => {
	assert.equal(isTrustedRequest(req({ host: "192.168.137.1:18080" }), CONFIG), true)
	assert.equal(isTrustedRequest(req({ host: "192.168.137.1:18080", origin: "http://192.168.137.1:18080" }), CONFIG), true)
})

test("跨站请求一律拒绝", () => {
	assert.equal(isTrustedRequest(req({ host: "127.0.0.1:54362", "sec-fetch-site": "cross-site" }), CONFIG), false)
})

test("Origin 与 Host 不同源时拒绝", () => {
	assert.equal(isTrustedRequest(req({ host: "127.0.0.1:54362", origin: "http://evil.example" }), CONFIG), false)
	assert.equal(isTrustedRequest(req({ host: "127.0.0.1:54362", origin: "null" }), CONFIG), true)
})

test("陌生 Host 拒绝", () => {
	assert.equal(isTrustedRequest(req({ host: "evil.example:80" }), CONFIG), false)
	assert.equal(isTrustedRequest(req({ host: "192.168.137.2:18080" }), CONFIG), false)
	assert.equal(isTrustedRequest(req({}), CONFIG), false)
	assert.equal(isTrustedRequest(req({ host: "127.0.0.1:54362", origin: "::bad::" }), CONFIG), false)
})
