/**
 * 注册到 DSH webServer 的三个精确路由：
 *   GET  /__lan_gate/widget.js  悬浮开关脚本
 *   GET  /__lan_gate/state      当前开关状态
 *   POST /__lan_gate/toggle     切换开关
 *
 * 这三个路由由 DSH 自己的 web server 提供（loopback），经代理访问时也能命中。
 * 所有写操作都做同源校验，防止其他网页跨站 POST 或 DNS 重绑定。
 *
 * @module dsh-lan-gate/routes
 */

import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** 悬浮开关脚本的路径。 */
export const WIDGET_PATH = "/__lan_gate/widget.js"
/** 状态查询路径。 */
export const STATE_PATH = "/__lan_gate/state"
/** 开关切换路径。 */
export const TOGGLE_PATH = "/__lan_gate/toggle"

const HERE = dirname(fileURLToPath(import.meta.url))
const WIDGET_FILE = join(HERE, "..", "assets", "widget.js")
const MAX_BODY_BYTES = 4096

/**
 * 判断主机名是否回环。
 * @param {string} hostname - 小写主机名。
 * @returns {boolean}
 */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true
	const parts = hostname.split(".")
	return parts.length === 4
		&& parts[0] === "127"
		&& parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/**
 * 同源校验：拒绝跨站请求、Origin 与 Host 不一致的请求；Host 必须是回环或本插件自己的地址。
 * @param {import("node:http").IncomingMessage} req - 请求。
 * @param {{ listenHost: string, port: number }} config - 监听配置。
 * @returns {boolean}
 */
export function isTrustedRequest(req, config) {
	const headers = req.headers ?? {}
	if (String(headers["sec-fetch-site"] ?? "").toLowerCase() === "cross-site") return false
	const host = String(headers.host ?? "").toLowerCase()
	if (host === "") return false
	let hostname
	try {
		hostname = new URL(`http://${host}`).hostname.toLowerCase()
	} catch {
		return false
	}
	const origin = headers.origin
	if (typeof origin === "string" && origin !== "" && origin !== "null") {
		try {
			if (new URL(origin).host.toLowerCase() !== host) return false
		} catch {
			return false
		}
	}
	if (isLoopbackHostname(hostname)) return true
	return host === `${config.listenHost}:${String(config.port)}`.toLowerCase()
}

/**
 * 读取 JSON 请求体（带上限）。
 * @param {import("node:http").IncomingMessage} req - 请求。
 * @returns {Promise<unknown>}
 */
async function readJsonBody(req) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > MAX_BODY_BYTES) throw new Error("请求体过大")
		chunks.push(chunk)
	}
	if (chunks.length === 0) return {}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"))
	} catch {
		throw new Error("请求体不是合法 JSON")
	}
}

/**
 * 写一个 JSON 响应。
 * @param {import("node:http").ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {unknown} value - JSON 内容。
 */
function sendJson(res, status, value) {
	const body = JSON.stringify(value)
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(body),
	})
	res.end(body)
}

/**
 * 注册三个路由。
 * @param {object} ctx - 插件上下文（已注入 webServer）。
 * @param {object} options - 依赖。
 * @param {{ status(): object, toggle(enabled: boolean): Promise<object> }} options.gate - 开关。
 * @param {{ listenHost: string, port: number }} options.config - 监听配置。
 * @param {(...args: unknown[]) => void} [options.log] - 日志。
 * @returns {Array<() => void>} 注销函数。
 */
export function registerRoutes(ctx, { gate, config, log = () => {} }) {
	/** @type {Array<() => void>} */
	const disposers = []

	disposers.push(ctx.webServer.register({
		kind: "exact",
		path: WIDGET_PATH,
		async handler(req, res) {
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405, { "cache-control": "no-store" })
				res.end()
				return
			}
			let source
			try {
				source = await readFile(WIDGET_FILE, "utf8")
			} catch (error) {
				log("读取悬浮开关脚本失败:", error)
				res.writeHead(500, { "cache-control": "no-store" })
				res.end()
				return
			}
			res.writeHead(200, {
				"content-type": "text/javascript; charset=utf-8",
				"cache-control": "no-store",
				"content-length": Buffer.byteLength(source),
			})
			res.end(source)
		},
	}))

	disposers.push(ctx.webServer.register({
		kind: "exact",
		path: STATE_PATH,
		handler(req, res) {
			if (req.method !== "GET") {
				res.writeHead(405, { "cache-control": "no-store" })
				res.end()
				return
			}
			if (!isTrustedRequest(req, config)) {
				res.writeHead(403, { "cache-control": "no-store" })
				res.end()
				return
			}
			sendJson(res, 200, gate.status())
		},
	}))

	disposers.push(ctx.webServer.register({
		kind: "exact",
		path: TOGGLE_PATH,
		async handler(req, res) {
			if (req.method !== "POST") {
				res.writeHead(405, { "cache-control": "no-store" })
				res.end()
				return
			}
			if (!isTrustedRequest(req, config)) {
				res.writeHead(403, { "cache-control": "no-store" })
				res.end()
				return
			}
			let requested
			try {
				const body = await readJsonBody(req)
				if (body !== null && typeof body === "object" && typeof (/** @type {{ enabled?: unknown }} */ (body)).enabled === "boolean") {
					requested = /** @type {{ enabled: boolean }} */ (body).enabled
				}
			} catch (error) {
				sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
				return
			}
			const next = requested ?? !gate.status().enabled
			try {
				sendJson(res, 200, await gate.toggle(next))
			} catch (error) {
				sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
			}
		},
	}))

	return disposers
}
