// ==UserScript==
// @name         Ubiquitous Web Optimizer v2
// @namespace    https://github.com/yourname/ubiquitous-web-optimizer
// @version      2.0.0
// @description  模块化重构：智能去广告 / 悬浮控制面板 (可拖拽+记忆) / 双击回顶 / 后台自动冻结定时器
// @author       You
// @license      MIT
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================
       全局配置
    ============================================ */
    const CONFIG = {
        adKeywords: ['广告', '推广', 'sponsored', 'advert'],          // 文本关键词
        adSelectors: [                                               // CSS 选择器
            '[class*="ad-"]', '[id*="ad-"]', '[class*="sponsor"]',
            '[data-ad]', '[data-advertisement]', '[aria-label*="广告"]'
        ],
        adExcludeSelectors: ['body', 'html', 'script', 'style', '#ub-optimizer-panel'], // 绝对不处理
        panelId: 'ub-optimizer-panel',
        nightStorageKey: 'ub-night-mode',
        panelPositionKey: 'ub-panel-pos',
        idleDeadline: 8               // requestIdleCallback 超时(ms)
    };

    /* ============================================
       工具函数
    ============================================ */
    const $ = (sel, ctx = document) => ctx.querySelector(sel);
    const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

    // 安全解析存储的 JSON
    function safeGetStorage(key, fallback = null) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch { return fallback; }
    }
    function safeSetStorage(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
    }

    /* ============================================
       1. 定时器劫持与后台冻结（重写底层）
    ============================================ */
    class TimerManager {
        #origSetTimeout = window.setTimeout;
        #origSetInterval = window.setInterval;
        #origClearTimeout = window.clearTimeout;
        #origClearInterval = window.clearInterval;

        #uid = 1;
        #timers = new Map();          // id → { type, callbackRef, delay, args, realId, status, remaining }

        constructor() {
            this.#hookTimers();
            document.addEventListener('visibilitychange', () => this.#onVisibilityChange());
        }

        #onVisibilityChange() {
            if (document.visibilityState === 'hidden') this.#pauseAll();
            else this.#resumeAll();
        }

        #pauseAll() {
            for (const [id, timer] of this.#timers.entries()) {
                if (timer.status !== 'active') continue;
                // 计算剩余时间（近似）
                timer.remaining = timer.type === 'timeout' ? timer.delay : timer.delay;
                if (timer.realId !== null) {
                    if (timer.type === 'timeout') this.#origClearTimeout.call(window, timer.realId);
                    else this.#origClearInterval.call(window, timer.realId);
                }
                timer.realId = null;
                timer.status = 'paused';
            }
        }

        #resumeAll() {
            for (const [id, timer] of this.#timers.entries()) {
                if (timer.status !== 'paused') continue;
                const callback = timer.callbackRef?.deref();
                if (!callback) {
                    this.#timers.delete(id);
                    continue;
                }

                if (timer.type === 'timeout') {
                    const newId = this.#origSetTimeout.call(window, (...args) => {
                        this.#timers.delete(id);
                        try { callback(...args); } catch (e) { console.error(e); }
                    }, timer.remaining ?? timer.delay);
                    timer.realId = newId;
                } else {
                    // interval 重新启动，仍使用原始 delay
                    const newId = this.#origSetInterval.call(window, callback, timer.delay, ...timer.args);
                    timer.realId = newId;
                }
                timer.status = 'active';
                timer.remaining = null;
            }
        }

        #hookTimers() {
            const manager = this;

            window.setTimeout = function (callback, delay, ...args) {
                const id = manager.#uid++;
                const timer = {
                    type: 'timeout',
                    callbackRef: new WeakRef(callback),
                    delay: Math.max(0, delay || 0),
                    args,
                    realId: null,
                    status: 'active',
                    remaining: null
                };

                if (document.visibilityState === 'visible') {
                    const realId = manager.#origSetTimeout.call(window, (...a) => {
                        manager.#timers.delete(id);
                        try { callback(...a); } catch (e) { console.error(e); }
                    }, timer.delay, ...args);
                    timer.realId = realId;
                } else {
                    timer.remaining = timer.delay;
                    timer.status = 'paused';
                }
                manager.#timers.set(id, timer);
                return id;
            };

            window.setInterval = function (callback, delay, ...args) {
                const id = manager.#uid++;
                const timer = {
                    type: 'interval',
                    callbackRef: new WeakRef(callback),
                    delay: Math.max(0, delay || 0),
                    args,
                    realId: null,
                    status: 'active',
                    remaining: null
                };

                if (document.visibilityState === 'visible') {
                    const realId = manager.#origSetInterval.call(window, callback, timer.delay, ...args);
                    timer.realId = realId;
                } else {
                    timer.remaining = timer.delay;
                    timer.status = 'paused';
                }
                manager.#timers.set(id, timer);
                return id;
            };

            window.clearTimeout = function (id) {
                const timer = manager.#timers.get(id);
                if (timer) {
                    if (timer.realId !== null) manager.#origClearTimeout.call(window, timer.realId);
                    manager.#timers.delete(id);
                } else {
                    manager.#origClearTimeout.call(window, id);
                }
            };

            window.clearInterval = function (id) {
                const timer = manager.#timers.get(id);
                if (timer) {
                    if (timer.realId !== null) manager.#origClearInterval.call(window, timer.realId);
                    manager.#timers.delete(id);
                } else {
                    manager.#origClearInterval.call(window, id);
                }
            };
        }
    }

    /* ============================================
       2. 广告过滤器（智能多重匹配）
    ============================================ */
    class AdFilter {
        #observer = null;
        #hiddenAttr = 'data-ub-filtered';

        constructor() {
            this.#initScan();
            this.#startObserver();
        }

        #shouldHide(el) {
            if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
            if (el.hasAttribute(this.#hiddenAttr)) return false;
            if (CONFIG.adExcludeSelectors.some(sel => el.matches?.(sel))) return false;

            // 1. 检查选择器匹配
            if (CONFIG.adSelectors.some(sel => el.matches?.(sel))) return true;

            // 2. 检查角色属性
            const role = el.getAttribute('role')?.toLowerCase();
            if (role === 'advertisement' || role === 'banner') return true;

            // 3. 检查文本关键词（仅直接文本，避免大段误判）
            const directText = Array.from(el.childNodes)
                .filter(n => n.nodeType === Node.TEXT_NODE)
                .map(n => n.textContent)
                .join('');
            if (CONFIG.adKeywords.some(kw => directText.includes(kw))) return true;

            // 4. aria-label 等
            const aria = el.getAttribute('aria-label');
            if (aria && CONFIG.adKeywords.some(kw => aria.includes(kw))) return true;

            return false;
        }

        #hideElement(el) {
            el.style.setProperty('display', 'none', 'important');
            el.setAttribute(this.#hiddenAttr, 'true');
        }

        #processElement(el) {
            // 递归处理子树，但若元素本身被隐藏则跳过子树
            if (this.#shouldHide(el)) {
                this.#hideElement(el);
                return;
            }
            // 检查子节点（只处理元素）
            for (const child of el.children) {
                this.#processElement(child);
            }
        }

        #initScan() {
            const scheduleScan = () => {
                if (!document.body) {
                    requestAnimationFrame(scheduleScan);
                    return;
                }
                // 使用空闲回调分片处理大型DOM
                const processChunk = (deadline) => {
                    // 简单实现：直接全量处理（现代页面通常可接受）
                    // 若要极致分片可改为队列遍历，这里不再增加复杂度
                    this.#processElement(document.body);
                };
                if (window.requestIdleCallback) {
                    requestIdleCallback(processChunk, { timeout: CONFIG.idleDeadline });
                } else {
                    setTimeout(processChunk, 1);
                }
            };
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', scheduleScan, { once: true });
            } else {
                scheduleScan();
            }
        }

        #startObserver() {
            const onMutation = (mutations) => {
                for (const m of mutations) {
                    for (const node of m.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            this.#processElement(node);
                        }
                    }
                }
            };
            this.#observer = new MutationObserver(onMutation);
            const startObserve = () => {
                if (document.body) {
                    this.#observer.observe(document.body, { childList: true, subtree: true });
                } else {
                    requestAnimationFrame(startObserve);
                }
            };
            startObserve();
        }
    }

    /* ============================================
       3. 悬浮控制面板（可拖拽、夜间模式、回顶）
    ============================================ */
    class FloatingPanel {
        #panel = null;
        #nightEnabled = false;
        #dragState = null;          // { startX, startY, origLeft, origTop, pointerId }

        constructor() {
            this.#nightEnabled = safeGetStorage(CONFIG.nightStorageKey, false);
            this.#injectStyles();
            this.#createPanel();
            this.#applyNightMode();       // 恢复夜间状态
            this.#bindEvents();
        }

        #injectStyles() {
            const id = 'ub-panel-style';
            if (document.getElementById(id)) return;
            const style = document.createElement('style');
            style.id = id;
            style.textContent = `
                #${CONFIG.panelId} {
                    position: fixed;
                    z-index: 2147483647;
                    right: 20px; top: 50%;
                    transform: translateY(-50%);
                    padding: 14px 16px;
                    background: rgba(255,255,255,0.25);
                    backdrop-filter: blur(16px);
                    -webkit-backdrop-filter: blur(16px);
                    border-radius: 18px;
                    border: 1px solid rgba(255,255,255,0.4);
                    box-shadow: 0 8px 32px rgba(0,0,0,0.15);
                    font-family: system-ui, -apple-system, sans-serif;
                    display: flex; flex-direction: column; gap: 10px;
                    user-select: none;
                    touch-action: none;
                    transition: opacity 0.2s;
                }
                #${CONFIG.panelId}.ub-dragging { opacity: 0.9; cursor: grabbing; }
                #${CONFIG.panelId} .ub-btn {
                    background: rgba(255,255,255,0.55);
                    border: none; border-radius: 12px;
                    padding: 10px 14px; font-size: 15px; font-weight: 500;
                    color: #1a1a1a; cursor: pointer;
                    backdrop-filter: blur(8px);
                    transition: background 0.15s;
                    white-space: nowrap;
                }
                #${CONFIG.panelId} .ub-btn:hover { background: rgba(255,255,255,0.8); }
                #${CONFIG.panelId} .ub-hint {
                    margin: 0; font-size: 11px; color: rgba(30,30,30,0.65);
                    text-align: center; line-height: 1.4;
                }
                /* 夜间模式全局滤镜 */
                html.ub-night-mode {
                    filter: invert(1) hue-rotate(180deg) !important;
                    background-color: #fff;
                }
                html.ub-night-mode img,
                html.ub-night-mode video,
                html.ub-night-mode canvas,
                html.ub-night-mode svg,
                html.ub-night-mode [style*="background-image"] {
                    filter: invert(1) hue-rotate(180deg) !important;
                }
                /* 面板本身二次反转 */
                html.ub-night-mode #${CONFIG.panelId} {
                    filter: invert(1) hue-rotate(180deg) !important;
                }
                @media (max-width: 600px) {
                    #${CONFIG.panelId} { right: 8px; padding: 10px; gap: 8px; }
                    #${CONFIG.panelId} .ub-btn { padding: 8px 12px; font-size: 14px; }
                }
            `;
            document.head.appendChild(style);
        }

        #createPanel() {
            this.#panel = document.createElement('div');
            this.#panel.id = CONFIG.panelId;

            const nightBtn = document.createElement('button');
            nightBtn.className = 'ub-btn';
            nightBtn.id = 'ub-night-btn';
            nightBtn.textContent = this.#nightEnabled ? '☀️ 日间模式' : '🌙 夜间模式';

            const topBtn = document.createElement('button');
            topBtn.className = 'ub-btn';
            topBtn.textContent = '⬆ 返回顶部';
            topBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

            const hint = document.createElement('p');
            hint.className = 'ub-hint';
            hint.textContent = '双击空白·回顶 | 拖拽移动';

            this.#panel.append(nightBtn, topBtn, hint);

            // 尝试恢复保存位置
            const savedPos = safeGetStorage(CONFIG.panelPositionKey);
            if (savedPos && savedPos.right != null && savedPos.top != null) {
                this.#panel.style.right = savedPos.right;
                this.#panel.style.top = savedPos.top;
                this.#panel.style.transform = 'none';
            }

            const append = () => {
                if (document.body) document.body.appendChild(this.#panel);
                else requestAnimationFrame(append);
            };
            append();
        }

        #toggleNightMode = () => {
            this.#nightEnabled = !this.#nightEnabled;
            this.#applyNightMode();
            safeSetStorage(CONFIG.nightStorageKey, this.#nightEnabled);
            const btn = document.getElementById('ub-night-btn');
            if (btn) btn.textContent = this.#nightEnabled ? '☀️ 日间模式' : '🌙 夜间模式';
        };

        #applyNightMode() {
            document.documentElement.classList.toggle('ub-night-mode', this.#nightEnabled);
        }

        #bindEvents() {
            // 夜间按钮事件
            const nightBtn = () => document.getElementById('ub-night-btn');
            const tryBind = () => {
                const btn = nightBtn();
                if (btn) {
                    btn.addEventListener('click', this.#toggleNightMode);
                } else {
                    requestAnimationFrame(tryBind);
                }
            };
            tryBind();

            // 拖拽功能
            this.#panel.addEventListener('pointerdown', this.#onDragStart.bind(this));
            window.addEventListener('pointermove', this.#onDragMove.bind(this));
            window.addEventListener('pointerup', this.#onDragEnd.bind(this));
            window.addEventListener('pointercancel', this.#onDragEnd.bind(this));
        }

        #onDragStart(e) {
            if (e.target.closest('button')) return; // 按钮不触发拖拽
            const rect = this.#panel.getBoundingClientRect();
            this.#dragState = {
                startX: e.clientX,
                startY: e.clientY,
                startRight: parseFloat(getComputedStyle(this.#panel).right) || 0,
                startTop: rect.top,
                pointerId: e.pointerId
            };
            this.#panel.setPointerCapture(e.pointerId);
            this.#panel.classList.add('ub-dragging');
            e.preventDefault();
        }

        #onDragMove(e) {
            if (!this.#dragState || e.pointerId !== this.#dragState.pointerId) return;
            const dx = e.clientX - this.#dragState.startX;
            const dy = e.clientY - this.#dragState.startY;
            const newRight = Math.max(0, this.#dragState.startRight - dx);
            const newTop = Math.min(window.innerHeight - 60, Math.max(0, this.#dragState.startTop + dy));
            this.#panel.style.right = newRight + 'px';
            this.#panel.style.top = newTop + 'px';
            this.#panel.style.transform = 'none';
            e.preventDefault();
        }

        #onDragEnd(e) {
            if (!this.#dragState || e.pointerId !== this.#dragState.pointerId) return;
            this.#panel.classList.remove('ub-dragging');
            this.#panel.releasePointerCapture(e.pointerId);
            // 保存位置
            const pos = {
                right: this.#panel.style.right,
                top: this.#panel.style.top
            };
            safeSetStorage(CONFIG.panelPositionKey, pos);
            this.#dragState = null;
        }
    }

    /* ============================================
       4. 双击空白回顶
    ============================================ */
    function initDoubleTapToTop() {
        document.addEventListener('dblclick', (e) => {
            const target = e.target;
            // 忽略面板内部
            if (target.closest(`#${CONFIG.panelId}`)) return;
            // 忽略交互元素
            if (target.closest('a, button, input, textarea, select, [contenteditable="true"], [role="button"], label, summary, details')) return;
            // 如果点击的是空白或者body/html
            if (target === document.body || target === document.documentElement || target.nodeType === Node.ELEMENT_NODE) {
                e.preventDefault();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        }, { passive: false });
    }

    /* ============================================
       启动一切
    ============================================ */
    function bootstrap() {
        new TimerManager();               // 最先劫持定时器
        new AdFilter();                   // 广告过滤
        new FloatingPanel();              // UI面板
        initDoubleTapToTop();             // 双击事件
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    } else {
        bootstrap();
    }
})();
