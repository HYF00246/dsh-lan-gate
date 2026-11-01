/**
 * dsh-lan-gate 插件入口。
 *
 * 两件事：
 *   1. 往 DSH 页面注入悬浮开关脚本（注入行必须在 apply 一开始就注册，
 *      因为桌面宿主只在启动时收集一次注入表）；
 *   2. 等 webServer / connection 就绪后，注册开关路由与代理。
 *
 * 代理只在用户点开开关时监听热点地址，关闭即释放端口。
 *
 * @module dsh-lan-gate
 */

import { createAuth } from "./auth.js"
import { createGate } from "./gate.js"
import { createProxyServer } from "./proxy.js"
import { registerRoutes, WIDGET_PATH } from "./routes.js"

/** Cordis 插件名。 */
export const name = "lan-gate"

/** 默认配置。 */
const DEFAULTS = Object.freeze({
	listenHost: "192.168.137.1",
	port: 18080,
	widget: true,
})

/**
 * 注入到 index 的一行自举脚本：自己创建 <script> 并吞掉 onerror。
 *
 * 不用 `script-src` 注入行：那种行加载失败会 reject 掉 `__DSH_BOOT_READY__`，
 * 让整个应用起不来；而这张注入表会被桌面宿主缓存，插件运行期被关掉时行仍在。
 */
const BOOT_SCRIPT = "(function(){try{if(window.__dshLanGateBooted===true)return;window.__dshLanGateBooted=true;"
	+ "var d=document.body||document.documentElement;if(!d)return;"
	+ `var s=document.createElement("script");s.src="${WIDGET_PATH}";s.async=true;s.onerror=function(){};`
	+ "d.appendChild(s)}catch(e){}})()"

/**
 * 校验并补全配置。
 * @param {unknown} raw - 插件行 `config` 的原始值。
 * @returns {{ listenHost: string, port: number, widget: boolean }}
 */
export function normalizeConfig(raw) {
	const source = raw !== null && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {}
	const listenHostRaw = source.listenHost
	const listenHost = typeof listenHostRaw === "string" && listenHostRaw.trim() !== ""
		? listenHostRaw.trim()
		: DEFAULTS.listenHost
	const portRaw = source.port === undefined ? DEFAULTS.port : source.port
	const port = Number(portRaw)
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`lan-gate: port 必须是 1-65535 的整数，收到 ${JSON.stringify(portRaw)}`)
	}
	return { listenHost, port, widget: source.widget !== false }
}

/**
 * 挂载插件。
 * @param {import("@deepseek-ai/cordis").Context} ctx - 插件上下文。
 * @param {unknown} [rawConfig] - 插件行配置。
 */
export function apply(ctx, rawConfig = {}) {
	const config = normalizeConfig(rawConfig)
	/** @param {...unknown} args */
	const log = (...args) => console.log("[lan-gate]", ...args)

	// ① 注入行：不依赖任何服务，必须在 apply 的第一时间注册。
	if (config.widget) {
		ctx.effect(() => ctx.on("webserver/index-inject", (table) => {
			if (!Array.isArray(table)) return
			const exists = table.some((row) => row !== null && typeof row === "object"
				&& ((row.kind === "script-src" && row.src === WIDGET_PATH)
					|| (row.kind === "script" && typeof row.text === "string" && row.text.indexOf(WIDGET_PATH) >= 0)))
			if (exists) return
			table.push({ kind: "script", placement: "body", text: BOOT_SCRIPT })
		}))
	}

	// ② 其余部分等两个服务就绪（不写对象级 inject，免得把 ① 一起推迟）。
	ctx.inject(["webServer", "connection"], (scoped) => {
		const auth = createAuth({ connection: scoped.connection, webServer: scoped.webServer })
		const gate = createGate({
			config,
			log,
			createServer: () => createProxyServer({ upstream: auth, log }),
		})

		scoped.effect(() => () => gate.dispose())
		scoped.effect(() => {
			const disposers = registerRoutes(scoped, { gate, config, log })
			return () => {
				for (const dispose of disposers) dispose()
			}
		})

		log(`已加载。界面右下角开关默认关闭；打开后监听 http://${config.listenHost}:${String(config.port)}`)
	})
}
