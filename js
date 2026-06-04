// ==UserScript==
// @name         Ubiquitous Web Optimizer v2
// @namespace    https://github.com/yourname/ubiquitous-web-optimizer
// @version      2.1.0
// @description  模块化重构：智能去广告 / 悬浮控制面板 (可拖拽+记忆) / 双击回顶 / 后台自动冻结定时器 / 快捷网站管理
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
        adExcludeSelectors: ['body', 'html', 'script', 'style', '#ub-optimizer-panel', '.ub-quick-link', '.ub-quick-delete'], // 绝对不处理
        panelId: 'ub-optimizer-panel',
        nightStorageKey: 'ub-night-mode',
        panelPositionKey: 'ub-panel-pos',
        quickLinksKey: 'ub-quick-links',
        maxQuickLinks: 12,          // 最大快捷网站数量
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

    // 提取主域名用于默认名称
    function getHostname(url) {
        try {
            const a = document.createElement('a');
            a.href = url;
            return a.hostname.replace(/^www\./, '');
        } catch { return '网站'; }
    }

    /* ============================================
       1. 定时器劫持与后台冻结（立即执行）
    ============================================ */
    class TimerManager {
        #origSetTimeout = window.setTimeout;
        #origSetInterval = window.setInterval;
        #origClearTimeout = window.clearTimeout;
        #origClearInterval = window.clearInterval;

        #uid = 1;
        #timers = new Map();          // id → { type, callback, delay, args, realId, status, remaining }

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
                const callback = timer.callback;
                if (typeof callback !== 'function') {
                    this.#timers.delete(id);
                    continue;
                }

                if (timer.type === 'timeout') {
                    const newId = this.#origSetTimeout.call(window, (...args) => {
                        this.#timers.delete(id);
                        try { callback(...args); } catch (e) { console.error(e); }
                    }, timer.remaining ?? timer.delay, ...timer.args);
                    timer.realId = newId;
                } else {
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
                    callback,
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
                    callback,
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
        #processingQueue = [];
        #processing = false;

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
            if (this.#shouldHide(el)) {
                this.#hideElement(el);
                return false; // 已隐藏，不再深入子节点
            }
            return true; // 继续处理子节点
        }

        #processNodeRecursive(node) {
            if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
            
            // 使用迭代而非递归避免栈溢出（深度优先手动栈）
            const stack = [node];
            while (stack.length) {
                const current = stack.pop();
                if (!current) continue;
                
                const shouldContinue = this.#processElement(current);
                if (shouldContinue && current.children) {
                    // 倒序推入保持原顺序（不影响结果）
                    for (let i = current.children.length - 1; i >= 0; i--) {
                        stack.push(current.children[i]);
                    }
                }
            }
        }

        #scheduleProcessing(node) {
            this.#processingQueue.push(node);
            if (!this.#processing) {
                this.#processing = true;
                if (window.requestIdleCallback) {
                    requestIdleCallback(() => this.#drainQueue(), { timeout: CONFIG.idleDeadline });
                } else {
                    setTimeout(() => this.#drainQueue(), 16);
                }
            }
        }

        #drainQueue() {
            const start = performance.now();
            while (this.#processingQueue.length && (performance.now() - start) < 32) {
                const node = this.#processingQueue.shift();
                if (node && node.isConnected) {
                    this.#processNodeRecursive(node);
                }
            }
            if (this.#processingQueue.length) {
                requestAnimationFrame(() => this.#drainQueue());
            } else {
                this.#processing = false;
            }
        }

        #initScan() {
            const scheduleScan = () => {
                if (!document.body) {
                    requestAnimationFrame(scheduleScan);
                    return;
                }
                this.#scheduleProcessing(document.body);
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
                        if (node.nodeType === Node.ELEMENT_NODE && node.isConnected) {
                            this.#scheduleProcessing(node);
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
       3. 悬浮控制面板（可拖拽、夜间模式、快捷网站）
    ============================================ */
    class FloatingPanel {
        #panel = null;
        #nightEnabled = false;
        #dragState = null;
        #quickLinks = [];

        constructor() {
            this.#nightEnabled = safeGetStorage(CONFIG.nightStorageKey, false);
            this.#quickLinks = safeGetStorage(CONFIG.quickLinksKey, []);
            this.#injectStyles();
            this.#createPanel();
            this.#applyNightMode();
            this.#bindEvents();
            this.#renderQuickLinks();
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
                    max-width: 280px;
                    min-width: 200px;
                }
                #${CONFIG.panelId}.ub-dragging { opacity: 0.9; cursor: grabbing; }
                #${CONFIG.panelId} .ub-btn {
                    background: rgba(255,255,255,0.55);
                    border: none; border-radius: 12px;
                    padding: 8px 12px; font-size: 14px; font-weight: 500;
                    color: #1a1a1a; cursor: pointer;
                    backdrop-filter: blur(8px);
                    transition: background 0.15s;
                    white-space: nowrap;
                }
                #${CONFIG.panelId} .ub-btn:hover { background: rgba(255,255,255,0.8); }
                #${CONFIG.panelId} .ub-section-title {
                    font-size: 11px;
                    font-weight: 600;
                    color: rgba(30,30,30,0.7);
                    margin: 4px 0 0 0;
                    letter-spacing: 0.5px;
                }
                #${CONFIG.panelId} .ub-quick-links {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    max-height: 200px;
                    overflow-y: auto;
                }
                #${CONFIG.panelId} .ub-quick-item {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    background: rgba(255,255,255,0.4);
                    border-radius: 10px;
                    padding: 4px 6px 4px 10px;
                    transition: background 0.1s;
                }
                #${CONFIG.panelId} .ub-quick-item:hover {
                    background: rgba(255,255,255,0.7);
                }
                #${CONFIG.panelId} .ub-quick-link {
                    flex: 1;
                    font-size: 13px;
                    font-weight: 500;
                    color: #1a1a1a;
                    text-decoration: none;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    cursor: pointer;
                }
                #${CONFIG.panelId} .ub-quick-delete {
                    background: rgba(0,0,0,0.1);
                    border: none;
                    border-radius: 20px;
                    width: 22px;
                    height: 22px;
                    font-size: 14px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: background 0.1s;
                    color: #333;
                }
                #${CONFIG.panelId} .ub-quick-delete:hover {
                    background: rgba(220,53,69,0.8);
                    color: white;
                }
                #${CONFIG.panelId} .ub-add-link {
                    background: rgba(255,255,255,0.5);
                    border: 1px dashed rgba(0,0,0,0.2);
                    margin-top: 2px;
                    font-size: 12px;
                    padding: 6px;
                }
                #${CONFIG.panelId} .ub-hint {
                    margin: 0; font-size: 10px; color: rgba(30,30,30,0.6);
                    text-align: center; line-height: 1.3;
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
                html.ub-night-mode #${CONFIG.panelId} {
                    filter: invert(1) hue-rotate(180deg) !important;
                }
                @media (max-width: 600px) {
                    #${CONFIG.panelId} { right: 8px; padding: 10px; gap: 8px; max-width: 240px; }
                    #${CONFIG.panelId} .ub-btn { padding: 6px 10px; font-size: 13px; }
                    #${CONFIG.panelId} .ub-quick-link { font-size: 12px; }
                }
            `;
            document.head.appendChild(style);
        }

        #createPanel() {
            this.#panel = document.createElement('div');
            this.#panel.id = CONFIG.panelId;

            // 夜间模式按钮
            const nightBtn = document.createElement('button');
            nightBtn.className = 'ub-btn';
            nightBtn.id = 'ub-night-btn';
            nightBtn.textContent = this.#nightEnabled ? '☀️ 日间模式' : '🌙 夜间模式';

            // 返回顶部按钮
            const topBtn = document.createElement('button');
            topBtn.className = 'ub-btn';
            topBtn.textContent = '⬆ 返回顶部';
            topBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

            // 快捷网站区域标题
            const sectionTitle = document.createElement('div');
            sectionTitle.className = 'ub-section-title';
            sectionTitle.textContent = '⚡ 快捷网站';

            // 快捷链接容器
            const linksContainer = document.createElement('div');
            linksContainer.className = 'ub-quick-links';

            // 添加按钮
            const addBtn = document.createElement('button');
            addBtn.className = 'ub-btn ub-add-link';
            addBtn.textContent = '+ 添加快捷网站';
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.#addQuickLink();
            });

            const hint = document.createElement('p');
            hint.className = 'ub-hint';
            hint.textContent = '双击空白·回顶 | 拖拽面板';

            this.#panel.append(nightBtn, topBtn, sectionTitle, linksContainer, addBtn, hint);
            
            // 保存容器引用
            this.#quickLinksContainer = linksContainer;

            // 恢复保存位置
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

        #renderQuickLinks() {
            if (!this.#quickLinksContainer) return;
            this.#quickLinksContainer.innerHTML = '';
            
            if (this.#quickLinks.length === 0) {
                const emptyHint = document.createElement('div');
                emptyHint.textContent = '暂无快捷网站，点击下方按钮添加';
                emptyHint.style.fontSize = '11px';
                emptyHint.style.color = 'rgba(0,0,0,0.5)';
                emptyHint.style.textAlign = 'center';
                emptyHint.style.padding = '6px';
                this.#quickLinksContainer.appendChild(emptyHint);
                return;
            }

            this.#quickLinks.forEach((link, index) => {
                const item = document.createElement('div');
                item.className = 'ub-quick-item';
                
                const linkEl = document.createElement('a');
                linkEl.className = 'ub-quick-link';
                linkEl.textContent = link.name || getHostname(link.url);
                linkEl.title = link.url;
                linkEl.href = link.url;
                linkEl.target = '_blank';
                linkEl.rel = 'noopener noreferrer';
                linkEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // 正常打开链接
                });
                
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'ub-quick-delete';
                deleteBtn.textContent = '✕';
                deleteBtn.title = '删除快捷方式';
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.#quickLinks.splice(index, 1);
                    this.#saveQuickLinks();
                    this.#renderQuickLinks();
                });
                
                item.appendChild(linkEl);
                item.appendChild(deleteBtn);
                this.#quickLinksContainer.appendChild(item);
            });
        }

        #addQuickLink() {
            let url = prompt('请输入网站地址（URL）:', 'https://');
            if (!url) return;
            url = url.trim();
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                url = 'https://' + url;
            }
            let name = prompt('请输入显示名称（可选）:', getHostname(url));
            if (!name) name = getHostname(url);
            
            if (this.#quickLinks.length >= CONFIG.maxQuickLinks) {
                alert(`最多添加 ${CONFIG.maxQuickLinks} 个快捷网站`);
                return;
            }
            
            this.#quickLinks.push({ id: Date.now() + Math.random(), name, url });
            this.#saveQuickLinks();
            this.#renderQuickLinks();
        }

        #saveQuickLinks() {
            safeSetStorage(CONFIG.quickLinksKey, this.#quickLinks);
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
            
            // 窗口resize时矫正位置边界
            window.addEventListener('resize', () => this.#clampPosition());
        }

        #clampPosition() {
            if (!this.#panel) return;
            const rect = this.#panel.getBoundingClientRect();
            const right = parseFloat(this.#panel.style.right) || 20;
            const top = parseFloat(this.#panel.style.top) || (window.innerHeight / 2);
            let newTop = top;
            let newRight = right;
            if (rect.height > window.innerHeight - 20) newTop = 20;
            else newTop = Math.min(window.innerHeight - rect.height - 10, Math.max(10, top));
            if (rect.width > window.innerWidth - 20) newRight = 10;
            else newRight = Math.min(window.innerWidth - rect.width - 10, Math.max(0, right));
            if (newTop !== top) this.#panel.style.top = newTop + 'px';
            if (newRight !== right) this.#panel.style.right = newRight + 'px';
        }

        #onDragStart(e) {
            if (e.target.closest('button, a, .ub-quick-delete, .ub-quick-link')) return;
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
            if (target.closest(`#${CONFIG.panelId}`)) return;
            if (target.closest('a, button, input, textarea, select, [contenteditable="true"], [role="button"], label, summary, details')) return;
            if (target === document.body || target === document.documentElement || target.nodeType === Node.ELEMENT_NODE) {
                e.preventDefault();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        }, { passive: false });
    }

    /* ============================================
       启动一切（定时器立即劫持，其他延迟到 DOM 就绪）
    ============================================ */
    // 立即劫持定时器（关键修复）
    const timerManager = new TimerManager();
    
    function bootstrap() {
        new AdFilter();
        new FloatingPanel();
        initDoubleTapToTop();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    } else {
        bootstrap();
    }
})();
