/*
    chatViewport.ts - 聊天列表的滚动锚定引擎
    2026/09/16 - Stapx Steve [林槐]

    这里只有一个东西：内容长高 / 变矮的时候，视口该往哪走。除此以外没有第二个地方
    可以写滚动位置 —— 以前有三处各自判断「我刚造成了多大位移，补多少回去」（图片
    解码事件带一个撑开量、列表更新算一次 scrollHeight 差、输入区预留区再算一次），
    三处都要自己判断「这次变化该不该补」，判据还各不相同。同一段高度被两处同时
    认领就是双倍补偿，判据差一档就是漏补，这正是「图片陆续解码时列表抖」的来源。

    模型（chat.css 的 .chat，column-reverse 反转流）：

      · 滚动原点在「最新一条」那一端，也就是屏幕底边。
      · scrollTop 为 0 = 视口钉在原点，往上翻是负值，所以
            gap = -scrollTop = 视口离原点多远（恒 >= 0）。
      · 内容是贴着原点往远端长的：某个孩子长高，它靠近原点的那条边不动，它**远端
        那一侧**的所有内容被整体推远；靠近原点那一侧一个像素都不动。

    于是「该不该动视口」这个问题有一个不需要任何猜测的答案：**看视口底边那一点
    内容有没有动**。内容长高之后，如果底边那点内容还在原来的屏幕位置上，那用户
    看的东西就没变，视口不需要动；如果它被推走了，视口就得跟着走同样多。

    这就是浏览器 scroll anchoring 的做法。这里手写一份的原因写在 chat.css 的
    overflow-anchor 那条注释里：Chromium 的锚定会在插历史时自己挑一个中间节点
    来维持位置，而反转流向下原点本来就不动 —— 两者叠加是重复补偿。所以锚定必须
    由我们自己算，且必须只有这一份。好处是三个内核（WebKitGTK / WebView2 /
    WKWebView）行为完全一致。

    边界情况一律按「不动」处理：锚点元素被删掉、拿不到锚点、用户正处于「跟随
    最新」（gap ≈ 0）的时候 —— 最后一种要钉在 0，而不是累加，否则每来一条新消息
    就把用户从底部顶开一点。
*/

/** 距底部多少像素以内算「还在跟随最新」。 */
const FOLLOW_THRESHOLD = 10

/**
 * 视口离滚动原点（最新一条）的距离，像素，恒 >= 0。
 *
 * .chat 是反转流向（chat.css 的 column-reverse），滚动坐标也跟着反了：scrollTop 为 0
 * 表示停在底部，往上翻是负值，范围 [-max, 0]。这是 CSSOM View 对反转流的规定，WebKit
 * 与 Chromium 都这么报。取负号把它翻成「离底多远」，其余逻辑一律拿这个正数思考。
 *
 * 负号只出现在下面这三个函数里 —— 「视口现在在哪」和「把视口写到哪」全项目只有这一份
 * 实现。自动锚定走本文件，主动跳转（appUtil 的 scrollToMsg）也走这三个，免得两处各写
 * 一遍反转流的符号，改内核约定时漏掉一处。
 */
export function panGap(pan: HTMLElement): number {
    return Math.max(0, -pan.scrollTop)
}

/** pan 能滚动的最大距离（内容不满一屏时为 0）。 */
export function panMaxGap(pan: HTMLElement): number {
    return Math.max(0, pan.scrollHeight - pan.clientHeight)
}

/**
 * 把视口写到「离原点 gap 像素」处，越界自动夹紧。
 *
 * behavior 逐次指定，不去改容器的 scroll-behavior：锚定补偿必须瞬时完成，只有主动跳转
 * （回到底部、跳到某条消息）才用平滑 —— 容器级一旦设成 smooth，所有补偿都会变成动画，
 * 和用户手势、内容高度变化互相追着跑，那正是最初的抖动源。
 */
export function writePanGap(pan: HTMLElement, gap: number, animate = false) {
    pan.scrollTo({
        top: -Math.min(Math.max(gap, 0), panMaxGap(pan)),
        behavior: animate ? 'smooth' : 'instant',
    })
}

export interface ChatViewport {
    /** 视口离滚动原点的距离（像素，恒 >= 0）。 */
    gap(): number
    /** 把视口钉在离原点 gap 像素处；越界自动夹紧。 */
    setGap(gap: number, animate?: boolean): void
    /** 是否处于「跟随最新」状态（用户停在底部附近）。 */
    following(): boolean
    /** 挂上监听，开始接管锚定。 */
    attach(): void
    /** 摘掉监听。 */
    detach(): void
}

interface Anchor {
    el: Element
    /** 锚点元素的底边相对视口底边的偏移：0 在底边上，负值在屏幕里。 */
    off: number
}

/**
 * @param getPan 取滚动容器（.chat）。每次要用的时候现取，因为切会话时这个节点会
 *               被 Vue 换掉。
 */
export function createChatViewport(getPan: () => HTMLElement | undefined): ChatViewport {
    let observer: ResizeObserver | undefined
    let prevHeight = 0
    let following = true
    let anchor: Anchor | undefined

    /** 视口底边那一点上，最靠里的那个元素 —— 锚点。空容器（点在容器自己身上）就没有锚点。 */
    function pickAnchor(pan: HTMLElement): Anchor | undefined {
        if (typeof document.elementFromPoint !== 'function') return undefined
        const panRect = pan.getBoundingClientRect()
        if (panRect.height < 1 || panRect.width < 1) return undefined
        const el = document.elementFromPoint(panRect.left + 4, panRect.bottom - 1)
        if (!el || el === pan || !pan.contains(el)) return undefined
        return { el, off: el.getBoundingClientRect().bottom - panRect.bottom }
    }

    function probe(pan: HTMLElement) {
        anchor = pickAnchor(pan)
    }

    function gap(): number {
        const pan = getPan()
        return pan ? panGap(pan) : 0
    }

    function setGap(value: number, animate = false) {
        const pan = getPan()
        if (!pan) return
        const target = Math.min(Math.max(value, 0), panMaxGap(pan))
        if (Math.abs(target - panGap(pan)) < 0.5 && !animate) {
            probe(pan)
            return
        }
        writePanGap(pan, target, animate)
        // 「跟随最新」的定义就是「视口停在原点附近」，所以每次落位之后直接按落点
        // 重算，不等滚动事件。滚动事件那一拍之前（同一帧里）还会有 ResizeObserver
        // 回调进来，那时候 following 必须已经是新的值 —— 否则一次程序化的
        // 「滚到 gap=600」会被当成还在跟随，下一个内容变化就把视口拽回原点。
        following = target <= FOLLOW_THRESHOLD
        probe(pan)
    }

    /**
     * 内容高度变了之后唯一的那条规则：
     *   锚点还在原处 → 用户看的东西没变，什么都不做。
     *   锚点被推走了 → 视口跟着走同样多。
     *   正处于跟随最新 → 钉回原点。
     */
    function onContentResize() {
        const pan = getPan()
        if (!pan) return
        const height = pan.scrollHeight
        const delta = height - prevHeight
        prevHeight = height
        if (delta === 0) return

        if (following) {
            setGap(0)
            return
        }
        const held = anchor
        if (!held || !held.el.isConnected) {
            // 锚点没了（列表被整体替换、切会话）—— 没有可靠参照就不要动视口
            probe(pan)
            return
        }
        const off = held.el.getBoundingClientRect().bottom - pan.getBoundingClientRect().bottom
        if (off !== held.off) {
            // 锚点底边在屏幕上的位置变了多少，视口就补多少（符号相反）
            setGap(gap() - (off - held.off))
        } else {
            probe(pan)
        }
    }

    function observedChildren(pan: HTMLElement): Element[] {
        return Array.from(pan.children)
    }

    let watched: Element[] = []

    /**
     * 观察 .chat 的三个孩子：占位、消息列表、历史状态区。它们的高度各自跟着内容走，
     * 任何一个长高都从这里出去，不需要每个图片自己发事件。
     *
     * 只有孩子集合真的变了才重新订阅：disconnect + observe 本身就是一次订阅变更，
     * 在 RO 回调里无条件做这件事会自己喂自己，报 "ResizeObserver loop completed with
     * undelivered notifications" 并且把主线程拉满（实测就是这么发现的）。
     */
    function syncObserved() {
        if (!observer) return
        const pan = getPan()
        if (!pan) return
        const next = observedChildren(pan)
        if (next.length === watched.length && next.every((el, i) => el === watched[i])) return
        observer.disconnect()
        watched = next
        for (const child of watched) observer.observe(child)
    }

    /**
     * 用户滚了 —— 只做一件事：按落点重算「是否还在跟随最新」，顺便重新选锚点。
     * 没有「这次滚动是不是我自己写的」这种判断：自己写滚动位置时 following 已经在
     * setGap 里按落点算过了，这里再算一遍是同一个值，不需要区分来源。
     */
    function onScroll() {
        const pan = getPan()
        if (!pan) return
        following = gap() <= FOLLOW_THRESHOLD
        probe(pan)
    }

    function attach() {
        const pan = getPan()
        if (!pan) return
        prevHeight = pan.scrollHeight
        following = gap() <= FOLLOW_THRESHOLD
        probe(pan)
        pan.addEventListener('scroll', onScroll, { passive: true })
        if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(() => {
                syncObserved()
                onContentResize()
            })
            syncObserved()
        }
    }

    function detach() {
        const pan = getPan()
        if (pan) pan.removeEventListener('scroll', onScroll)
        if (observer) {
            observer.disconnect()
            observer = undefined
        }
        anchor = undefined
        watched = []
    }

    return { gap, setGap, following: () => following, attach, detach }
}
