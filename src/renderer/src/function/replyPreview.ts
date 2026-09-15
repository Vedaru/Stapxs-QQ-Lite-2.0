import { ObjectDirective } from 'vue'
import { requestReplyPreview } from './msg'

/**
 * 回复预览的按需补拉。回复段只带一个目标 id，目标不在分页窗口里就没法渲染预览，
 * 得去 get_msg 补拉一条；但一屏里可能挂着几十条老回复，全部一起请求会很浪费，
 * 所以这里用一个共用的 IntersectionObserver：只有真划到视口附近的回复行才触发。
 *
 * 观察器做成模块级的单例（和 tooltip.ts 里的指令一个路子），而不是每挂载一次就
 * new 一个 —— 它的状态是纯共享的，没必要每个实例各持一份。
 */
let observer: IntersectionObserver | undefined

const vReplyBackfill: ObjectDirective<HTMLElement, string> = {
    mounted(el, binding) {
        if (!binding.value) return
        el.dataset.replyId = binding.value
        if (observer === undefined) {
            observer = new IntersectionObserver((entries) => {
                entries.forEach((entry) => {
                    if (!entry.isIntersecting) return
                    const id = (entry.target as HTMLElement).dataset.replyId
                    observer?.unobserve(entry.target)
                    if (id) requestReplyPreview(id)
                })
            }, {
                root: document.getElementById('msgPan'),
                // 只在「上面」放宽：旧消息是从视口顶边翻出来的，提前一屏半屏拉好，
                // 滚到位时通常已经补完。底部不放宽是有意的 —— 补拉会让这一行长高，
                // 而增长发生在视口下方时，整屏可见内容会被往上顶一截；只在视口内或
                // 视口上方增长，被顶走的那部分都在屏幕外，看不出来。
                rootMargin: '200px 0px 0px 0px',
            })
        }
        observer.observe(el)
    },
    updated(el, binding) {
        // 补到了（或确认拿不到）→ 绑定值变成空串，不用再盯着这一行了
        if (!binding.value) {
            observer?.unobserve(el)
            delete el.dataset.replyId
        }
    },
    unmounted(el) {
        observer?.unobserve(el)
    },
}

export { vReplyBackfill }
