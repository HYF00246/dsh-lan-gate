/**
 * dsh-lan-gate 的悬浮开关。
 *
 * 由 DSH index 注入的内联脚本加载（见 lib/index.js），在页面右下角显示一个固定宽度的胶囊：
 *   单击        切换局域网访问开关
 *   长按 450ms  进入拖动，松手落位
 *
 * 布局约定：
 *   - 位置按「距右下角的距离」记录，窗口缩放 / 进入全屏都锚定右下角，不会错位；
 *   - 胶囊宽度固定，开关状态不改变长度；访问地址只在悬停提示里出现；
 *   - 与鲸鱼挂件（.dshwv-img）重叠时，抬到它可见部分的上方，且最多抬到视口中线。
 *
 * 独立 IIFE + Shadow DOM：不依赖 DSH 的客户端模块系统，也不污染页面样式。
 */
(function () {
	"use strict"

	if (window.__dshLanGateWidget === true) return
	window.__dshLanGateWidget = true

	var STATE_URL = "/__lan_gate/state"
	var TOGGLE_URL = "/__lan_gate/toggle"
	var POSITION_KEY = "dsh-lan-gate:position"
	var HOLD_MS = 450
	var MOVE_THRESHOLD = 10
	var ERROR_MS = 4000
	var GAP = 16
	/** 小于这个宽度（手机）不显示悬浮开关，避免挡住发送/确认按钮。 */
	var MOBILE_MAX_WIDTH = 820
	/** 在线探测间隔：手机上靠它发现「电脑那边把开关关了」。 */
	var WATCH_INTERVAL_MS = 3000
	/** 连续失败几次判定为连接已断开。 */
	var DISCONNECT_AFTER_FAILURES = 2
	/** 用户选择「继续等待」后，多少毫秒内不再弹窗。 */
	var DISMISS_QUIET_MS = 30000

	var host = document.createElement("div")
	host.id = "dsh-lan-gate"
	host.style.cssText = "position:fixed;z-index:2147483000;left:auto;top:auto;right:" + GAP + "px;bottom:" + GAP + "px;touch-action:none;"

	var shadow = host.attachShadow({ mode: "open" })
	var style = document.createElement("style")
	style.textContent = [
		":host{all:initial}",
		".pill{box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:6px;width:118px;height:32px;padding:0 10px;",
		"border-radius:999px;border:1px solid rgba(0,0,0,.14);background:#f3f4f6;color:#374151;",
		"font:600 12px/1 system-ui,-apple-system,'Segoe UI',sans-serif;cursor:pointer;",
		"box-shadow:0 2px 10px rgba(0,0,0,.14);user-select:none;-webkit-user-select:none;touch-action:none;white-space:nowrap;overflow:hidden}",
		".pill:hover{filter:brightness(.97)}",
		".pill.on{background:#16a34a;border-color:#15803d;color:#fff}",
		".pill.error{background:#dc2626;border-color:#b91c1c;color:#fff}",
		".pill.busy{opacity:.65;cursor:progress}",
		".dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:#9ca3af}",
		".pill.on .dot,.pill.error .dot{background:#fff}",
		".label{flex:0 0 auto;opacity:.9}",
		".state{flex:0 0 auto;font-weight:700;letter-spacing:.5px}",
		":host(.dragging) .pill{cursor:grabbing;box-shadow:0 6px 22px rgba(0,0,0,.28)}",
		"@media (prefers-color-scheme:dark){.pill:not(.on):not(.error){background:#2b2b30;border-color:rgba(255,255,255,.18);color:#e5e7eb}}",
	].join("")
	var button = document.createElement("button")
	button.type = "button"
	button.className = "pill"
	button.setAttribute("aria-pressed", "false")
	button.innerHTML = '<span class="dot"></span><span class="label">局域网访问</span><span class="state">关</span>'
	shadow.appendChild(style)
	shadow.appendChild(button)

	var stateEl = button.querySelector(".state")
	var state = { enabled: false, busy: false, address: "", error: "" }
	/** @type {{right: number, bottom: number} | null} */
	var position = null
	var drag = null
	var holdTimer = 0
	var errorTimer = 0

	/** 按当前状态刷新按钮外观。 */
	function render() {
		button.classList.toggle("on", state.enabled && state.error === "")
		button.classList.toggle("error", state.error !== "")
		button.classList.toggle("busy", state.busy)
		button.setAttribute("aria-pressed", state.enabled ? "true" : "false")
		if (state.busy) stateEl.textContent = "…"
		else if (state.error !== "") stateEl.textContent = "失败"
		else stateEl.textContent = state.enabled ? "开" : "关"
		button.title = state.error !== ""
			? state.error
			: state.enabled
				? "局域网访问已开启" + (state.address === "" ? "" : "：http://" + state.address) + "\n点一下关闭"
				: "局域网访问已关闭，点一下开启"
	}

	/**
	 * 显示一条临时错误。
	 * @param {string} message - 错误文本。
	 */
	function showError(message) {
		state.error = String(message || "操作失败")
		clearTimeout(errorTimer)
		errorTimer = setTimeout(function () {
			state.error = ""
			render()
		}, ERROR_MS)
		render()
	}

	/**
	 * 应用服务端状态。
	 * @param {{ enabled?: boolean, address?: string, error?: string | null }} payload - 状态。
	 */
	function applyStatus(payload) {
		if (payload === null || typeof payload !== "object") return
		state.enabled = payload.enabled === true
		state.address = typeof payload.address === "string" ? payload.address : ""
		if (typeof payload.error === "string" && payload.error !== "") showError(payload.error)
		else {
			state.error = ""
			render()
		}
	}

	/** 读取服务端状态。 */
	function refresh() {
		fetch(STATE_URL, { headers: { accept: "application/json" }, cache: "no-store" })
			.then(function (response) { return response.ok ? response.json() : null })
			.then(function (payload) { if (payload !== null) applyStatus(payload) })
			.catch(function () { /* 页面刚起来时可能还没就绪 */ })
	}

	/** 切换开关。 */
	function toggle() {
		if (state.busy) return
		state.busy = true
		state.error = ""
		render()
		fetch(TOGGLE_URL, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ enabled: !state.enabled }),
			cache: "no-store",
		})
			.then(function (response) {
				return response.json().then(function (payload) { return { ok: response.ok, payload: payload } })
			})
			.then(function (result) {
				state.busy = false
				if (result.ok) applyStatus(result.payload)
				else showError((result.payload && result.payload.error) || "操作失败")
			})
			.catch(function () {
				state.busy = false
				showError("无法连接 DSH")
			})
	}

	// ── 连接已断开的提示 ────────────────────────────────────────────────
	// 手机上页面经过代理访问，电脑一关开关，所有请求都会失败。
	// 轮询 /__lan_gate/state 连续失败即弹窗；点「确定」清空页面（连带清掉
	// DSH 客户端在本地排队的待发消息），避免重新打开开关后被一次性补发。

	/** @type {HTMLDivElement | null} */
	var disconnectOverlay = null
	var consecutiveFailures = 0
	var quietUntil = 0

	/** 退出页面：先试 close()，被浏览器拒绝就跳到空白页（同样会卸载页面）。 */
	function exitPage() {
		try {
			window.close()
		} catch (error) { /* 被浏览器拒绝，走下面的兜底 */ }
		setTimeout(function () {
			try {
				window.location.replace("about:blank")
			} catch (error) { /* 忽略 */ }
		}, 60)
	}

	/** 构造断线弹窗。 */
	function buildDisconnectOverlay() {
		var overlay = document.createElement("div")
		overlay.setAttribute("role", "dialog")
		overlay.setAttribute("aria-modal", "true")
		overlay.style.cssText = [
			"position:fixed", "inset:0", "z-index:2147483600",
			"display:flex", "align-items:center", "justify-content:center",
			"background:rgba(15,23,42,.55)",
			"font:14px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif",
			"-webkit-font-smoothing:antialiased",
		].join(";")

		var card = document.createElement("div")
		card.style.cssText = [
			"box-sizing:border-box", "max-width:min(360px,86vw)", "padding:22px 20px",
			"border-radius:14px", "background:#fff", "color:#111827", "text-align:center",
			"box-shadow:0 18px 48px rgba(0,0,0,.32)",
		].join(";")

		var title = document.createElement("div")
		title.textContent = "局域网访问已关闭"
		title.style.cssText = "font-size:16px;font-weight:700;margin-bottom:8px"

		var body = document.createElement("div")
		body.textContent = "与电脑的连接已断开：可能是电脑上关掉了「局域网访问」，或手机与热点断开。"
		body.style.cssText = "color:#4b5563;margin-bottom:16px"

		var ok = document.createElement("button")
		ok.type = "button"
		ok.textContent = "确定，退出页面"
		ok.style.cssText = [
			"width:100%", "height:38px", "border:none", "border-radius:10px",
			"background:#16a34a", "color:#fff", "font:600 14px/1 system-ui,sans-serif",
			"cursor:pointer",
		].join(";")
		ok.addEventListener("click", exitPage)

		var stay = document.createElement("button")
		stay.type = "button"
		stay.textContent = "继续等待连接"
		stay.style.cssText = [
			"margin-top:8px", "width:100%", "height:34px", "border:none", "border-radius:10px",
			"background:transparent", "color:#6b7280", "font:500 13px/1 system-ui,sans-serif",
			"cursor:pointer",
		].join(";")
		stay.addEventListener("click", function () {
			quietUntil = Date.now() + DISMISS_QUIET_MS
			hideDisconnect()
		})

		card.appendChild(title)
		card.appendChild(body)
		card.appendChild(ok)
		card.appendChild(stay)
		overlay.appendChild(card)
		return overlay
	}

	/** 显示断线弹窗（重复调用无副作用）。 */
	function showDisconnect() {
		if (disconnectOverlay !== null) return
		if (document.body === null) return
		disconnectOverlay = buildDisconnectOverlay()
		document.body.appendChild(disconnectOverlay)
	}

	/** 关闭断线弹窗（连接恢复时调用）。 */
	function hideDisconnect() {
		if (disconnectOverlay === null) return
		disconnectOverlay.remove()
		disconnectOverlay = null
	}

	/** 探测一次连接；连续失败就弹窗。 */
	function pollGate() {
		var options = { headers: { accept: "application/json" }, cache: "no-store" }
		if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
			options.signal = AbortSignal.timeout(2500)
		}
		fetch(STATE_URL, options)
			.then(function (response) {
				if (!response.ok) throw new Error("bad status")
				return response.json()
			})
			.then(function (payload) {
				consecutiveFailures = 0
				hideDisconnect()
				if (!state.busy) applyStatus(payload)
			})
			.catch(function () {
				consecutiveFailures += 1
				if (consecutiveFailures >= DISCONNECT_AFTER_FAILURES && Date.now() >= quietUntil) showDisconnect()
			})
	}

	/**
	 * 按「距右下角」的偏移落位，并收拢到视口内。
	 * @param {number} right - 右边距。
	 * @param {number} bottom - 下边距。
	 * @param {boolean} [remember] - 是否写入 localStorage。
	 */
	function place(right, bottom, remember) {
		var width = host.offsetWidth || 118
		var height = host.offsetHeight || 32
		var maxRight = Math.max(8, window.innerWidth - width - 8)
		var maxBottom = Math.max(8, window.innerHeight - height - 8)
		var nextRight = Math.min(Math.max(8, Math.round(right)), maxRight)
		var nextBottom = Math.min(Math.max(8, Math.round(bottom)), maxBottom)
		host.style.right = nextRight + "px"
		host.style.bottom = nextBottom + "px"
		host.style.left = "auto"
		host.style.top = "auto"
		position = { right: nextRight, bottom: nextBottom }
		if (remember === true) {
			try {
				window.localStorage.setItem(POSITION_KEY, JSON.stringify(position))
			} catch (error) { /* 隐私模式下可能不可写，忽略 */ }
		}
	}

	/** 默认落位：右下角。 */
	function defaultPosition() {
		place(GAP, GAP)
	}

	/** 首次落位：有记忆用记忆，否则默认。 */
	function initialPlace() {
		var saved = null
		try {
			saved = JSON.parse(window.localStorage.getItem(POSITION_KEY) || "null")
		} catch (error) { saved = null }
		if (saved !== null && typeof saved.right === "number" && typeof saved.bottom === "number") {
			place(saved.right, saved.bottom)
			return
		}
		defaultPosition()
	}

	host.addEventListener("pointerdown", function (event) {
		if (event.pointerType === "mouse" && event.button !== 0) return
		event.preventDefault()
		var rect = host.getBoundingClientRect()
		drag = {
			id: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			startRight: window.innerWidth - rect.right,
			startBottom: window.innerHeight - rect.bottom,
			dragging: false,
			cancelled: false,
		}
		try { host.setPointerCapture(event.pointerId) } catch (error) { /* 忽略 */ }
		holdTimer = setTimeout(function () {
			if (drag === null) return
			drag.dragging = true
			host.classList.add("dragging")
		}, HOLD_MS)
	})

	host.addEventListener("pointermove", function (event) {
		if (drag === null || event.pointerId !== drag.id) return
		var dx = event.clientX - drag.startX
		var dy = event.clientY - drag.startY
		if (!drag.dragging) {
			if (Math.abs(dx) + Math.abs(dy) > MOVE_THRESHOLD) {
				clearTimeout(holdTimer)
				drag.cancelled = true
			}
			return
		}
		place(drag.startRight - dx, drag.startBottom - dy)
	})

	host.addEventListener("pointerup", function (event) {
		if (drag === null || event.pointerId !== drag.id) return
		clearTimeout(holdTimer)
		var wasDragging = drag.dragging
		var wasCancelled = drag.cancelled
		drag = null
		host.classList.remove("dragging")
		try { host.releasePointerCapture(event.pointerId) } catch (error) { /* 忽略 */ }
		if (wasDragging) {
			if (position !== null) place(position.right, position.bottom, true)
		} else if (!wasCancelled) {
			toggle()
		}
	})

	host.addEventListener("pointercancel", function () {
		clearTimeout(holdTimer)
		drag = null
		host.classList.remove("dragging")
	})

	// 窗口缩放 / 进出全屏：按「距右下角」重新收拢，位置保持一致
	window.addEventListener("resize", function () {
		if (position !== null) place(position.right, position.bottom)
		else defaultPosition()
	})

	/**
	 * 手机等窄屏隐藏悬浮开关：它固定浮在右下角，会挡住发送/确认/取消按钮。
	 * 电脑端（宽屏）照常显示。
	 */
	var narrowQuery = typeof window.matchMedia === "function"
		? window.matchMedia("(max-width: " + MOBILE_MAX_WIDTH + "px)")
		: null

	/** 按视口宽度同步显示/隐藏。 */
	function syncVisibility() {
		host.style.display = narrowQuery !== null && narrowQuery.matches ? "none" : ""
	}

	if (narrowQuery !== null) {
		if (typeof narrowQuery.addEventListener === "function") narrowQuery.addEventListener("change", syncVisibility)
		else if (typeof narrowQuery.addListener === "function") narrowQuery.addListener(syncVisibility)
	}

	/** 挂载。 */
	function mount() {
		var parent = document.body || document.documentElement
		if (parent === null) {
			setTimeout(mount, 50)
			return
		}
		parent.appendChild(host)
		syncVisibility()
		initialPlace()
		render()
		refresh()
		// 手机上靠轮询发现「电脑关掉了开关」，然后弹窗提示并允许退出页面。
		// 只在前台轮询：切后台/锁屏就停，回到前台立刻探一次。
		syncWatch()
		// 布局稳定后校正一次（字体、鲸鱼挂件可能稍后才出现）
		setTimeout(function () {
			if (position === null) defaultPosition()
			else place(position.right, position.bottom)
		}, 400)
	}

	/** 当前是否在前台（页面可见）。 */
	function pageVisible() {
		return typeof document.visibilityState === "string" ? document.visibilityState === "visible" : true
	}

	var watchTimer = 0

	/** 开始轮询（幂等）。 */
	function startWatch() {
		if (watchTimer !== 0) return
		watchTimer = window.setInterval(pollGate, WATCH_INTERVAL_MS)
	}

	/** 停止轮询（幂等）。 */
	function stopWatch() {
		if (watchTimer === 0) return
		window.clearInterval(watchTimer)
		watchTimer = 0
	}

	/** 按页面可见性启停轮询；回到前台立即探测一次。 */
	function syncWatch() {
		if (pageVisible()) {
			pollGate()
			startWatch()
		} else {
			stopWatch()
		}
	}

	document.addEventListener("visibilitychange", syncWatch)
	window.addEventListener("pagehide", stopWatch)
	window.addEventListener("pageshow", syncWatch)

	render()
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true })
	else mount()
})()