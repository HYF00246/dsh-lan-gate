/**
 * 局域网开关的状态机：串行处理开启/关闭，避免连点导致重复监听。
 *
 * 状态：off → starting → on → stopping → off
 * 打开失败（热点没开、端口被占）保持 off 并带上可读原因，绝不"假装打开"。
 *
 * @module dsh-lan-gate/gate
 */

/** 监听等待上限。 */
const LISTEN_TIMEOUT_MS = 5000

/**
 * 把底层错误翻译成给用户看的一句话。
 * @param {unknown} error - 错误。
 * @param {{ listenHost: string, port: number }} config - 当前配置。
 * @returns {string}
 */
export function describeFailure(error, config) {
	const code = /** @type {{ code?: string }} */ (error)?.code
	if (code === "EADDRNOTAVAIL") return `热点未开启，或 ${config.listenHost} 这个地址当前不可用`
	if (code === "EADDRINUSE") return `端口 ${String(config.port)} 已被占用`
	if (code === "EACCES") return `没有权限监听端口 ${String(config.port)}`
	return error instanceof Error ? error.message : String(error)
}

/**
 * 在指定地址上监听，返回一个在 listening / error / 超时后必结算的 Promise。
 * @param {import("node:http").Server} server - 待监听的服务器。
 * @param {{ listenHost: string, port: number }} config - 监听配置。
 * @returns {Promise<void>}
 */
function listen(server, config) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup()
			reject(Object.assign(new Error("监听超时"), { code: "ETIMEDOUT" }))
		}, LISTEN_TIMEOUT_MS)
		function cleanup() {
			clearTimeout(timer)
			server.off("listening", onListening)
			server.off("error", onError)
		}
		function onListening() {
			cleanup()
			resolve()
		}
		function onError(error) {
			cleanup()
			reject(error)
		}
		server.once("listening", onListening)
		server.once("error", onError)
		server.listen(config.port, config.listenHost)
	})
}

/**
 * 创建开关。
 * @param {object} options - 依赖。
 * @param {{ listenHost: string, port: number }} options.config - 监听配置。
 * @param {() => { server: import("node:http").Server, close(): Promise<void> }} options.createServer - 服务器工厂。
 * @param {(...args: unknown[]) => void} [options.log] - 日志。
 * @returns {{ status(): GateStatus, toggle(enabled: boolean): Promise<GateStatus>, dispose(): Promise<void> }}
 */
export function createGate({ config, createServer, log = () => {} }) {
	/** @type {"off" | "starting" | "on" | "stopping"} */
	let state = "off"
	/** @type {{ server: import("node:http").Server, close(): Promise<void> } | null} */
	let active = null
	/** @type {string | null} */
	let error = null
	/** @type {Promise<unknown>} */
	let queue = Promise.resolve()

	const address = () => `${config.listenHost}:${String(config.port)}`

	/** @returns {GateStatus} */
	function status() {
		return {
			state,
			enabled: state === "on",
			address: address(),
			error,
		}
	}

	/**
	 * 把任务排进串行队列。
	 * @template T
	 * @param {() => Promise<T>} task - 任务。
	 * @returns {Promise<T>}
	 */
	function serialize(task) {
		const result = queue.then(task, task)
		queue = result.then(() => undefined, () => undefined)
		return result
	}

	/** @returns {Promise<GateStatus>} */
	async function start() {
		if (state === "on") return status()
		state = "starting"
		error = null
		let created = null
		try {
			created = createServer()
			await listen(created.server, config)
			active = created
			state = "on"
			log(`已开启：http://${address()}`)
		} catch (cause) {
			if (created !== null) {
				try {
					await created.close()
				} catch { /* 关闭一个从未监听的服务器本来就可能报错，忽略 */ }
			}
			active = null
			state = "off"
			error = describeFailure(cause, config)
			log(`开启失败：${error}`)
		}
		return status()
	}

	/** @returns {Promise<GateStatus>} */
	async function stop() {
		if (state === "off" && active === null) return status()
		state = "stopping"
		const current = active
		active = null
		if (current !== null) {
			try {
				// 兜底：关闭动作最长等 3 秒，避免任何下层实现卡住时开关永远停在 stopping
				await Promise.race([
					current.close(),
					new Promise((resolve) => setTimeout(resolve, 3000)),
				])
			} catch (cause) {
				log("关闭时出错:", cause)
			}
		}
		state = "off"
		error = null
		log("已关闭")
		return status()
	}

	return {
		status,
		/**
		 * 串行切换开关。
		 * @param {boolean} enabled - true 打开，false 关闭。
		 * @returns {Promise<GateStatus>}
		 */
		toggle(enabled) {
			return serialize(() => (enabled ? start() : stop()))
		},
		/** 插件卸载/DSH 退出时调用。 */
		dispose() {
			return serialize(() => stop())
		},
	}
}

/**
 * @typedef {object} GateStatus
 * @property {"off" | "starting" | "on" | "stopping"} state - 当前状态。
 * @property {boolean} enabled - 是否正在监听。
 * @property {string} address - `host:port`。
 * @property {string | null} error - 最近一次失败原因。
 */
