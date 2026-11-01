/**
 * 反向代理：把手机发到热点地址的请求转给本机的 DSH web server。
 *
 * 三件事必须同时做对，否则上游会 401/403：
 *   1. `Host` 改写为上游 authority（Cookie 名与签名都绑定了它）；
 *   2. `Origin` 改写为上游同源、`Sec-Fetch-Site` 删除（cross-site 一律 403）；
 *   3. 注入合法 `dsh-auth-*` Cookie。
 *
 * 另外：WebSocket 握手不能丢 `Upgrade`/`Connection`/`Sec-WebSocket-*`；
 * 服务器不能设任何请求/空闲超时（会掐断流式输出和 WS 心跳）。
 *
 * @module dsh-lan-gate/proxy
 */

import http from "node:http"
import net from "node:net"

/** 普通请求需要丢掉的逐跳头。 */
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"te",
	"trailer",
	"proxy-authorization",
	"proxy-authenticate",
])

/** upgrade 请求需要丢掉的头（保留 Connection/Upgrade/Sec-WebSocket-*）。 */
const UPGRADE_DROP = new Set([
	"proxy-connection",
	"proxy-authorization",
	"proxy-authenticate",
	"keep-alive",
	"te",
	"trailer",
	"transfer-encoding",
])

/**
 * 允许转发的路径。其余一律 404——尤其 `/connect` 会签发 API 凭据，必须挡住。
 * @param {string} pathname - 解码前的 URL pathname。
 * @returns {boolean}
 */
export function isForwardablePath(pathname) {
	if (typeof pathname !== "string" || pathname === "") return false
	if (pathname === "/" || pathname === "/index.html" || pathname === "/favicon.ico") return true
	return pathname.startsWith("/assets/")
		|| pathname.startsWith("/plugins/")
		|| pathname.startsWith("/api/")
		|| pathname.startsWith("/__lan_gate/")
}

/**
 * 解析请求 URL 的 pathname（失败返回空串，调用方按不可转发处理）。
 * @param {string | undefined} url - 原始 req.url。
 * @returns {string}
 */
export function pathOf(url) {
	try {
		return new URL(url ?? "/", "http://lan-gate.invalid").pathname
	} catch {
		return ""
	}
}

/**
 * 合并 Cookie：丢掉客户端带来的 dsh-auth-*，换成插件持有的那一条。
 * @param {string | undefined} original - 客户端 Cookie 头。
 * @param {string} injected - 插件的 Cookie。
 * @returns {string}
 */
export function mergeCookie(original, injected) {
	const kept = String(original ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part !== "" && !part.startsWith("dsh-auth-"))
	return [...kept, injected].join("; ")
}

/**
 * 改写请求头。
 * @param {Record<string, string | string[] | undefined>} raw - 原始请求头。
 * @param {object} options - 改写参数。
 * @param {string} options.authority - 上游 authority。
 * @param {string} options.cookie - 要注入的 Cookie。
 * @param {boolean} [options.upgrade] - 是否 WebSocket 握手。
 * @returns {Record<string, string | string[]>}
 */
export function rewriteRequestHeaders(raw, { authority, cookie, upgrade = false }) {
	const drop = upgrade ? UPGRADE_DROP : HOP_BY_HOP
	/** @type {Record<string, string | string[]>} */
	const out = {}
	for (const [name, value] of Object.entries(raw)) {
		if (value === undefined) continue
		const key = name.toLowerCase()
		if (drop.has(key)) continue
		if (key === "host") continue
		if (key === "sec-fetch-site") continue
		if (key === "origin") {
			out.origin = `http://${authority}`
			continue
		}
		if (key === "referer") {
			out.referer = String(value).replace(/^https?:\/\/[^/]+/u, `http://${authority}`)
			continue
		}
		out[key] = value
	}
	out.host = authority
	out.cookie = mergeCookie(typeof raw.cookie === "string" ? raw.cookie : undefined, cookie)
	return out
}

/**
 * 过滤响应头：丢掉逐跳头与 Set-Cookie（不让手机存上游的 Cookie）。
 * @param {Record<string, string | string[] | undefined>} raw - 上游响应头。
 * @returns {Record<string, string | string[]>}
 */
export function filterResponseHeaders(raw) {
	/** @type {Record<string, string | string[]>} */
	const out = {}
	for (const [name, value] of Object.entries(raw)) {
		if (value === undefined) continue
		const key = name.toLowerCase()
		if (HOP_BY_HOP.has(key) || key === "set-cookie") continue
		out[key] = value
	}
	return out
}

/**
 * 给客户端一个最小错误响应。
 * @param {http.ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {unknown} error - 错误。
 */
function respondError(res, status, error) {
	if (res.headersSent) {
		res.destroy()
		return
	}
	const message = error instanceof Error ? error.message : String(error)
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
	res.end(`lan-gate: ${message}\n`)
}

/**
 * 创建代理服务器。
 * @param {object} options - 依赖。
 * @param {{ get(): Promise<import("./auth.js").Upstream>, invalidate(): void }} options.upstream - Cookie 持有者。
 * @param {(...args: unknown[]) => void} [options.log] - 日志。
 * @returns {{ server: http.Server, close(): Promise<void> }}
 */
export function createProxyServer({ upstream, log = () => {} }) {
	/** @type {Set<import("node:net").Socket>} */
	const sockets = new Set()

	/**
	 * 转发一次 HTTP 请求；401 时换 Cookie 重试一次（仅无请求体的方法）。
	 * @param {http.IncomingMessage} req - 客户端请求。
	 * @param {http.ServerResponse} res - 客户端响应。
	 * @param {import("./auth.js").Upstream} up - 上游信息。
	 * @param {number} attempt - 重试序号。
	 * @returns {Promise<void>}
	 */
	function forward(req, res, up, attempt) {
		return new Promise((resolve) => {
			const headers = rewriteRequestHeaders(req.headers, { authority: up.authority, cookie: up.cookie })
			const request = http.request({
				host: up.host,
				port: up.port,
				method: req.method,
				path: req.url,
				headers,
			}, (response) => {
				const status = response.statusCode ?? 502
				if (status === 401 && attempt === 0 && (req.method === "GET" || req.method === "HEAD")) {
					response.resume()
					response.on("end", () => {
						upstream.invalidate()
						upstream.get()
							.then((next) => forward(req, res, next, attempt + 1))
							.then(() => resolve(), (error) => { respondError(res, 502, error); resolve() })
					})
					return
				}
				res.writeHead(status, filterResponseHeaders(response.headers))
				response.pipe(res)
				response.on("end", () => resolve())
				response.on("aborted", () => { res.destroy(); resolve() })
			})
			request.on("error", (error) => {
				if (!res.headersSent) respondError(res, 502, error)
				else res.destroy()
				resolve()
			})
			req.on("aborted", () => request.destroy())
			req.pipe(request)
		})
	}

	/**
	 * 处理一条 WebSocket 升级：原样转发握手与后续字节。
	 * @param {http.IncomingMessage} req - 升级请求。
	 * @param {import("node:net").Socket} socket - 客户端 socket。
	 * @param {Buffer} head - 首包。
	 * @returns {Promise<void>}
	 */
	async function handleUpgrade(req, socket, head) {
		const pathname = pathOf(req.url)
		if (!isForwardablePath(pathname)) {
			socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
			return
		}
		let up
		try {
			up = await upstream.get()
		} catch (error) {
			log("upgrade 上游不可用:", error)
			socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
			return
		}
		if (socket.destroyed) return
		const headers = rewriteRequestHeaders(req.headers, { authority: up.authority, cookie: up.cookie, upgrade: true })
		const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`]
		for (const [name, value] of Object.entries(headers)) {
			if (Array.isArray(value)) for (const one of value) lines.push(`${name}: ${one}`)
			else lines.push(`${name}: ${value}`)
		}
		const target = net.connect(up.port, up.host, () => {
			target.write(`${lines.join("\r\n")}\r\n\r\n`)
			if (head !== undefined && head.length > 0) target.write(head)
			target.pipe(socket)
			socket.pipe(target)
		})
		target.on("error", () => socket.destroy())
		socket.on("error", () => target.destroy())
		socket.on("close", () => target.destroy())
		target.on("close", () => socket.destroy())
	}

	const server = http.createServer((req, res) => {
		const pathname = pathOf(req.url)
		if (!isForwardablePath(pathname)) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
			res.end("Not Found\n")
			return
		}
		upstream.get()
			.then((up) => forward(req, res, up, 0))
			.catch((error) => {
				log("请求上游不可用:", error)
				respondError(res, 502, error)
			})
	})

	// 不设任何请求/空闲超时：长请求、流式输出与 WebSocket 心跳都依赖长连接。
	server.requestTimeout = 0
	server.timeout = 0
	server.headersTimeout = 60_000
	server.keepAliveTimeout = 65_000

	server.on("upgrade", (req, socket, head) => {
		void handleUpgrade(req, socket, head)
	})
	server.on("clientError", (_error, socket) => {
		if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
		else socket.destroy()
	})
	server.on("connection", (socket) => {
		sockets.add(socket)
		socket.once("close", () => sockets.delete(socket))
	})

	return {
		server,
		/**
		 * 关闭监听并断开所有连接（含已升级的 WebSocket）。
		 *
		 * 注意顺序：`server.close()` 只是停止接受新连接，它要等现有连接全部结束才回调；
		 * 浏览器的 keep-alive / WebSocket 会长期挂着，所以必须先主动销毁连接，
		 * 否则关闭动作永远不返回，开关会卡在 "stopping"。
		 */
		async close() {
			const closed = new Promise((resolve) => {
				if (!server.listening) {
					resolve()
					return
				}
				server.once("close", () => resolve())
			})
			try {
				server.close()
			} catch { /* 已经关闭 */ }
			if (typeof server.closeAllConnections === "function") server.closeAllConnections()
			for (const socket of sockets) socket.destroy()
			sockets.clear()
			// 兜底：即使底层没有及时回调，也不让开关卡死
			await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))])
		},
	}
}
