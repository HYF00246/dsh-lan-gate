import assert from "node:assert/strict"
import test from "node:test"

import {
	filterResponseHeaders,
	isForwardablePath,
	mergeCookie,
	pathOf,
	rewriteRequestHeaders,
} from "../lib/proxy.js"

const AUTHORITY = "127.0.0.1:54362"
const COOKIE = "dsh-auth-abc=xyz"

test("isForwardablePath 只放行代理需要的路径", () => {
	assert.equal(isForwardablePath("/"), true)
	assert.equal(isForwardablePath("/index.html"), true)
	assert.equal(isForwardablePath("/favicon.ico"), true)
	assert.equal(isForwardablePath("/assets/index-abc.js"), true)
	assert.equal(isForwardablePath("/plugins/foo/client.js"), true)
	assert.equal(isForwardablePath("/plugins/events"), true)
	assert.equal(isForwardablePath("/api/remote.mux"), true)
	assert.equal(isForwardablePath("/__lan_gate/state"), true)

	assert.equal(isForwardablePath("/connect"), false, "/connect 会签发 API 凭据，必须挡住")
	assert.equal(isForwardablePath("/unknown"), false)
	assert.equal(isForwardablePath(""), false)
	assert.equal(isForwardablePath(undefined), false)
})

test("pathOf 解析 pathname，非法输入返回空串", () => {
	assert.equal(pathOf("/api/remote.mux?x=1"), "/api/remote.mux")
	assert.equal(pathOf(undefined), "/")
	assert.equal(pathOf("http://x/"), "/")
})

test("mergeCookie 丢弃客户端的 dsh-auth-*，保留其它 Cookie", () => {
	assert.equal(mergeCookie(undefined, COOKIE), COOKIE)
	assert.equal(mergeCookie("a=1; dsh-auth-old=bad; b=2", COOKIE), "a=1; b=2; dsh-auth-abc=xyz")
	assert.equal(mergeCookie("  ", COOKIE), COOKIE)
})

test("rewriteRequestHeaders：改写 Host/Origin、删除 Sec-Fetch-Site、注入 Cookie", () => {
	const out = rewriteRequestHeaders({
		host: "192.168.137.1:18080",
		origin: "http://192.168.137.1:18080",
		"sec-fetch-site": "same-origin",
		referer: "http://192.168.137.1:18080/s/1",
		cookie: "dsh-auth-old=bad; theme=dark",
		accept: "text/html",
	}, { authority: AUTHORITY, cookie: COOKIE })

	assert.equal(out.host, AUTHORITY)
	assert.equal(out.origin, `http://${AUTHORITY}`)
	assert.equal(out["sec-fetch-site"], undefined)
	assert.equal(out.referer, `http://${AUTHORITY}/s/1`)
	assert.equal(out.cookie, `theme=dark; ${COOKIE}`)
	assert.equal(out.accept, "text/html")
})

test("rewriteRequestHeaders：普通请求丢掉逐跳头", () => {
	const out = rewriteRequestHeaders({
		connection: "keep-alive",
		"keep-alive": "timeout=5",
		"proxy-connection": "keep-alive",
		"transfer-encoding": "chunked",
		te: "trailers",
		trailer: "x",
		"proxy-authorization": "x",
	}, { authority: AUTHORITY, cookie: COOKIE })

	for (const key of ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "proxy-authorization"]) {
		assert.equal(out[key], undefined, `${key} 不应转发`)
	}
})

test("rewriteRequestHeaders：upgrade 请求保留 Connection/Upgrade/Sec-WebSocket-*", () => {
	const out = rewriteRequestHeaders({
		host: "192.168.137.1:18080",
		connection: "Upgrade",
		upgrade: "websocket",
		"sec-websocket-key": "abc",
		"sec-websocket-version": "13",
		"sec-websocket-protocol": "dsh.remote.v1",
		"sec-websocket-extensions": "permessage-deflate",
		"sec-fetch-site": "same-origin",
		"proxy-connection": "keep-alive",
	}, { authority: AUTHORITY, cookie: COOKIE, upgrade: true })

	assert.equal(out.connection, "Upgrade")
	assert.equal(out.upgrade, "websocket")
	assert.equal(out["sec-websocket-key"], "abc")
	assert.equal(out["sec-websocket-version"], "13")
	assert.equal(out["sec-websocket-protocol"], "dsh.remote.v1")
	assert.equal(out["sec-websocket-extensions"], "permessage-deflate")
	assert.equal(out["sec-fetch-site"], undefined)
	assert.equal(out["proxy-connection"], undefined)
	assert.equal(out.host, AUTHORITY)
	assert.equal(out.cookie, COOKIE)
})

test("filterResponseHeaders：丢掉逐跳头与 Set-Cookie", () => {
	const out = filterResponseHeaders({
		"content-type": "text/html",
		"set-cookie": ["dsh-auth-abc=xyz; HttpOnly"],
		connection: "keep-alive",
		"transfer-encoding": "chunked",
		"content-encoding": "gzip",
	})

	assert.equal(out["content-type"], "text/html")
	assert.equal(out["content-encoding"], "gzip")
	assert.equal(out["set-cookie"], undefined)
	assert.equal(out.connection, undefined)
	assert.equal(out["transfer-encoding"], undefined)
})
