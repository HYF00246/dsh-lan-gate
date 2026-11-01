import assert from "node:assert/strict"
import test from "node:test"

import { createAuth, pickAuthCookie } from "../lib/auth.js"

test("pickAuthCookie 只挑 dsh-auth-* Cookie", () => {
	assert.equal(pickAuthCookie(["_ga=1; Path=/", "dsh-auth-abc=xyz; Path=/; HttpOnly"]), "dsh-auth-abc=xyz")
	assert.equal(pickAuthCookie(["theme=dark"]), undefined)
	assert.equal(pickAuthCookie([]), undefined)
})

test("createAuth 用启动令牌换 Cookie，并缓存结果", async () => {
	let fetchCalls = 0
	let lastUrl
	const webServer = { getOrigin: () => "http://127.0.0.1:54362" }
	const connection = { authenticatedUrl: (base) => `${base}?token=launch-token` }

	const auth = createAuth({
		webServer,
		connection,
		fetchImpl: async (url) => {
			fetchCalls += 1
			lastUrl = url
			return new Response(null, {
				status: 303,
				headers: { "set-cookie": "dsh-auth-abc=xyz; Path=/; HttpOnly; SameSite=Strict" },
			})
		},
	})

	const first = await auth.get()
	assert.equal(fetchCalls, 1)
	assert.equal(lastUrl, "http://127.0.0.1:54362/?token=launch-token")
	assert.deepEqual(
		{ authority: first.authority, host: first.host, port: first.port, cookie: first.cookie },
		{ authority: "127.0.0.1:54362", host: "127.0.0.1", port: 54362, cookie: "dsh-auth-abc=xyz" },
	)

	const second = await auth.get()
	assert.equal(fetchCalls, 1, "第二次应命中缓存")
	assert.equal(second.cookie, first.cookie)

	auth.invalidate()
	await auth.get()
	assert.equal(fetchCalls, 2, "invalidate 后应重新换取")
})

test("createAuth 在上游没有 Set-Cookie 时报错", async () => {
	const auth = createAuth({
		webServer: { getOrigin: () => "http://127.0.0.1:54362" },
		connection: { authenticatedUrl: (base) => base },
		fetchImpl: async () => new Response("nope", { status: 401 }),
	})
	await assert.rejects(() => auth.get(), /无法换取浏览器 Cookie/u)
})

test("createAuth 在上游端口未绑定前透出错误", async () => {
	const auth = createAuth({
		webServer: { getOrigin: () => { throw new Error("origin read before bound") } },
		connection: { authenticatedUrl: (base) => base },
		fetchImpl: async () => new Response(null),
	})
	await assert.rejects(() => auth.get(), /origin read before bound/u)
})
