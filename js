// ==UserScript==
// @name         Ubiquitous Web Optimizer
// @namespace    https://github.com/yourname/ubiquitous-web-optimizer
// @version      1.0.0
// @description  广告隐藏 / 夜间模式 / 返回顶部 / 后台自动暂停定时器
// @author       You
// @license      MIT
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ---------- 1. 定时器劫持（节省后台内存） ----------
    const origSetTimeout = window.setTimeout;
    const origSetInterval = window.setInterval;
    const origClearTimeout = window.clearTimeout;
    const origClearInterval = window.clearInterval;

    let uid = 1;
    const timers = new Map(); // id -> { type, callback, delay, args, realId, remaining, status }

    function pauseAllTimers() {
        for (const [id, timer] of timers.entries()) {
            if (timer.status === 'active') {
                if (timer.realId !== null) {
                    if (timer.type === 'timeout') {
                        origClearTimeout.call(window, timer.realId);
                    } else {
                        origClearInterval.call(window, timer.realId);
                    }
                }
                timer.realId = null;
                timer.remaining = timer.delay;
                timer.status = 'paused';
            }
        }
    }

    function resumeAllTimers() {
        for (const [id, timer] of timers.entries()) {
            if (timer.status === 'paused') {
                if (timer.type === 'timeout') {
                    const realId = origSetTimeout.call(window, function () {
                        timers.delete(id);
                        try {
                            timer.callback.apply(this, timer.args);
                        } catch (e) {
                            console.error(e);
                        }
                    }, timer.remaining || 0);
                    timer.realId = realId;
                } else {
                    // interval
                    const realId = origSetInterval.call(window, timer.callback, timer.delay, ...timer.args);
                    timer.realId = realId;
                }
                timer.status = 'active';
                timer.remaining = null;
            }
        }
    }

    window.setTimeout = function (callback, delay, ...args) {
        const id = uid++;
        const timer = {
            type: 'timeout',
            callback,
            delay: Math.max(0, delay || 0),
            args,
            realId: null,
            remaining: null,
            status: 'active'
        };

        if (document.visibilityState === 'visible') {
            const realId = origSetTimeout.call(window, function () {
                timers.delete(id);
                try {
                    callback.apply(this, args);
                } catch (e) {
                    console.error(e);
                }
            }, timer.delay);
            timer.realId = realId;
        } else {
            timer.remaining = timer.delay;
            timer.status = 'paused';
        }

        timers.set(id, timer);
        return id;
    };

    window.setInterval = function (callback, delay, ...args) {
        const id = uid++;
        const timer = {
            type: 'interval',
            callback,
            delay: Math.max(0, delay || 0),
            args,
            realId: null,
            remaining: null,
            status: 'active'
        };

        if (document.visibilityState === 'visible') {
            const realId = origSetInterval.call(window, callback, timer.delay, ...args);
            timer.realId = realId;
        } else {
            timer.remaining = timer.delay;
            timer.status = 'paused';
        }

        timers.set(id, timer);
        return id;
    };

    window.clearTimeout = function (id) {
        const timer = timers.get(id);
        if (timer) {
            if (timer.realId !== null) {
                origClearTimeout.call(window, timer.realId);
            }
            timers.delete(id);
        } else {
            origClearTimeout.call(window, id);
        }
    };

    window.clearInterval = function (id) {
        const timer = timers.get(id);
        if (timer) {
            if (timer.realId !== null) {
                origClearInterval.call(window, timer.realId);
            }
            timers.delete(id);
        } else {
            origClearInterval.call(window, id);
        }
    };

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            pauseAllTimers();
        } else if (document.visibilityState === 'visible') {
            resumeAllTimers();
        }
    });

    // ---------- 2. 广告隐藏（MutationObserver） ----------
    const AD_KEYWORDS = ['广告', '推广'];
    const HIDDEN_ATTR = 'data-ub-hidden';

    function shouldHideElement(el) {
        // 不处理 body/html 和已隐藏的元素
        if (el === document.body || el === document.documentElement) return false;
        if (el.hasAttribute(HIDDEN_ATTR)) return false;
        try {
            const text = el.textContent || '';
            return AD_KEYWORDS.some(kw => text.includes(kw));
        } catch (e) {
            return false;
        }
    }

    function hideElement(el) {
        el.style.setProperty('display', 'none', 'important');
        el.setAttribute(HIDDEN_ATTR, 'true');
    }

    function processElementForAds(el) {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
        if (shouldHideElement(el)) {
            hideElement(el);
            return;
        }
        // 递归检查子元素
        const children = el.children;
        for (let i = 0; i < children.length; i++) {
            processElementForAds(children[i]);
        }
    }

    function scanWholeDocument() {
        if (document.body) {
            processElementForAds(document.body);
        }
    }

    // 页面初始扫描
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scanWholeDocument);
    } else {
        scanWholeDocument();
    }

    // 动态插入监听
    const adObserver = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    processElementForAds(node);
                }
            }
        }
    });

    function startAdObserver() {
        if (document.body) {
            adObserver.observe(document.body, { childList: true, subtree: true });
        } else {
            const waitBody = () => {
                if (document.body) {
                    adObserver.observe(document.body, { childList: true, subtree: true });
                    document.removeEventListener('DOMContentLoaded', waitBody);
                }
            };
            document.addEventListener('DOMContentLoaded', waitBody);
        }
    }
    startAdObserver();

    // ---------- 3. 悬浮面板、夜间模式、双击返回顶部 ----------
    const PANEL_ID = 'ubiquitous-optimizer-panel';
    const NIGHT_CLASS = 'ubiquitous-night-mode';
    let nightEnabled = false;

    // 注入样式
    function injectStyles() {
        const css = `
            #${PANEL_ID} {
                position: fixed;
                right: 16px;
                top: 50%;
                transform: translateY(-50%);
                z-index: 2147483647;
                display: flex;
                flex-direction: column;
                gap: 10px;
                padding: 12px 14px;
                background: rgba(255, 255, 255, 0.22);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                border-radius: 14px;
                border: 1px solid rgba(255, 255, 255, 0.3);
                box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
                font-family: system-ui, -apple-system, sans-serif;
                transition: opacity 0.3s ease;
                user-select: none;
            }
            @media (max-width: 600px) {
                #${PANEL_ID} {
                    right: 8px;
                    padding: 10px 10px;
                    gap: 8px;
                    border-radius: 12px;
                }
            }
            #${PANEL_ID} .ub-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(255, 255, 255, 0.45);
                border: none;
                border-radius: 10px;
                padding: 8px 12px;
                font-size: 14px;
                font-weight: 500;
                color: #222;
                cursor: pointer;
                transition: background 0.2s;
                white-space: nowrap;
                backdrop-filter: blur(6px);
                -webkit-backdrop-filter: blur(6px);
            }
            #${PANEL_ID} .ub-btn:hover {
                background: rgba(255, 255, 255, 0.7);
            }
            #${PANEL_ID} .ub-hint {
                font-size: 11px;
                color: rgba(30, 30, 30, 0.7);
                text-align: center;
                margin: 0;
                line-height: 1.3;
            }
            @media (max-width: 600px) {
                #${PANEL_ID} .ub-btn {
                    padding: 6px 10px;
                    font-size: 13px;
                }
                #${PANEL_ID} .ub-hint {
                    font-size: 10px;
                }
            }
            /* 夜间模式 */
            html.${NIGHT_CLASS} {
                filter: invert(1) hue-rotate(180deg) !important;
                background-color: #fff; /* 避免一些透明背景异常 */
            }
            html.${NIGHT_CLASS} img,
            html.${NIGHT_CLASS} video,
            html.${NIGHT_CLASS} canvas,
            html.${NIGHT_CLASS} svg,
            html.${NIGHT_CLASS} [style*="background-image"] {
                filter: invert(1) hue-rotate(180deg) !important;
            }
            /* 确保面板本身不受夜间模式影响（双重反转） */
            html.${NIGHT_CLASS} #${PANEL_ID} {
                filter: invert(1) hue-rotate(180deg) !important;
            }
        `;
        const style = document.createElement('style');
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }
    injectStyles();

    // 创建面板
    function createPanel() {
        if (document.getElementById(PANEL_ID)) return;

        const panel = document.createElement('div');
        panel.id = PANEL_ID;

        // 夜间模式按钮
        const nightBtn = document.createElement('button');
        nightBtn.className = 'ub-btn';
        nightBtn.textContent = '🌙 夜间模式';
        nightBtn.addEventListener('click', toggleNightMode);

        // 提示文字
        const hint = document.createElement('p');
        hint.className = 'ub-hint';
        hint.textContent = '双击空白 · 返回顶部';

        // （可选）手动返回顶部按钮
        const topBtn = document.createElement('button');
        topBtn.className = 'ub-btn';
        topBtn.textContent = '⬆ 返回顶部';
        topBtn.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });

        panel.appendChild(nightBtn);
        panel.appendChild(topBtn);
        panel.appendChild(hint);
        document.body.appendChild(panel);
    }

    function toggleNightMode() {
        const html = document.documentElement;
        nightEnabled = !nightEnabled;
        if (nightEnabled) {
            html.classList.add(NIGHT_CLASS);
        } else {
            html.classList.remove(NIGHT_CLASS);
        }
        const btn = document.querySelector(`#${PANEL_ID} .ub-btn`);
        if (btn) {
            btn.textContent = nightEnabled ? '☀️ 日间模式' : '🌙 夜间模式';
        }
    }

    // 确保 body 存在后创建面板
    function initPanel() {
        if (document.body) {
            createPanel();
        } else {
            document.addEventListener('DOMContentLoaded', createPanel);
        }
    }
    initPanel();

    // 双击空白返回顶部
    document.addEventListener('dblclick', function (e) {
        const target = e.target;
        // 面板内双击不触发
        if (target.closest(`#${PANEL_ID}`)) return;
        // 避免在链接、按钮、输入框等交互元素上触发
        const interactive = target.closest(
            'a, button, input, textarea, select, [contenteditable="true"], [role="button"], label, summary, details, [onclick]'
        );
        if (!interactive || target === document.body || target === document.documentElement) {
            e.preventDefault();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    });

})();
