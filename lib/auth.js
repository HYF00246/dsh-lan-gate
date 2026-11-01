/**
 * 换取并缓存上游 DSH web server 的浏览器会话 Cookie。
 *
 * DSH 的 web 载体要求每个请求带 `dsh-auth-*` 签名 Cookie；启动令牌只能用一次
 * （`GET /?token=...` 换 Cookie 并 303）。插件跑在同一进程里，可以直接用官方
 * `connection.authenticatedUrl()` 拿到带令牌的 URL，再在进程内换成 Cookie，
 * 之后替手机代持——不读取任何凭据文件，也不绕过 DSH 的校验。
 *
 * @module dsh-lan-gate/auth
 */

/** Cookie 交换的上游路径要求是根路径，这里统一补斜杠。 */
function normalizeBase(origin) {
	return origin.endsWith("/") ? origin : `${origin}/`
}

/**
 * 从一组 Set-Cookie 头里挑出 DSH 的浏览器 Cookie。
 * @param {string[]} headers - Set-Cookie 头。
 * @returns {string | undefined} `name=value` 形式；没有则 undefined。
 */
export function pickAuthCookie(headers) {
	for (const header of headers) {
		if (typeof header !== "string") continue
		const match = /^(dsh-auth-[A-Za-z0-9_-]+)=([^;]*)/u.exec(header)
		if (match !== null) return `${match[1]}=${match[2]}`
	}
	return undefined
}

/**
 * 创建 Cookie 持有者。
 * @param {object} options - 依赖。
 * @param {object} options.connection - DSH connection 服务（提供 authenticatedUrl）。
 * @param {object} options.webServer - DSH webServer 服务（提供 getOrigin）。
 * @param {typeof fetch} [options.fetchImpl] - 便于测试替换的 fetch。
 * @param {number} [options.timeoutMs] - 交换超时。
 * @returns {{ get(): Promise<Upstream>, invalidate(): void }}
 */
export function createAuth({ connection, webServer, fetchImpl = fetch, timeoutMs = 5000 }) {
	/** @type {Upstream | undefined} */
	let cached

	/**
	 * 用启动令牌换一份新的浏览器 Cookie。
	 * @param {string} origin - 上游 origin，例如 `http://127.0.0.1:54362`。
	 * @returns {Promise<Upstream>}
	 */
	async function exchange(origin) {
		if (typeof connection?.authenticatedUrl !== "function") {
			throw new Error("lan-gate: connection.authenticatedUrl 不可用（DSH 版本不匹配？）")
		}
		const tokenUrl = connection.authenticatedUrl(normalizeBase(origin))
		const response = await fetchImpl(tokenUrl, {
			redirect: "manual",
			headers: { accept: "text/html" },
			signal: AbortSignal.timeout(timeoutMs),
		})
		const raw = typeof response.headers.getSetCookie === "function"
			? response.headers.getSetCookie()
			: [response.headers.get("set-cookie")].filter((value) => typeof value === "string")
		const cookie = pickAuthCookie(raw)
		if (cookie === undefined) {
			throw new Error(`lan-gate: 无法换取浏览器 Cookie（上游返回 ${String(response.status)}）`)
		}
		const url = new URL(origin)
		return {
			origin,
			authority: url.host,
			host: url.hostname,
			port: Number(url.port === "" ? (url.protocol === "https:" ? 443 : 80) : url.port),
			cookie,
		}
	}

	return {
		/** 丢弃缓存，下一次 get() 重新换一次（上游 401 时调用）。 */
		invalidate() {
			cached = undefined
		},
		/**
		 * 取得可用的上游信息。上游地址在端口绑定前不可读，因此惰性求值。
		 * @returns {Promise<Upstream>}
		 */
		async get() {
			const origin = webServer.getOrigin()
			if (cached !== undefined && cached.origin === origin) return cached
			cached = await exchange(origin)
			return cached
		},
	}
}

/**
 * @typedef {object} Upstream
 * @property {string} origin - `http://127.0.0.1:54362`
 * @property {string} authority - `127.0.0.1:54362`
 * @property {string} host - `127.0.0.1`
 * @property {number} port - `54362`
 * @property {string} cookie - `dsh-auth-xxx=...`
 */
