/**
 * Umami 统计的懒加载入口。
 *
 * 直接静态 import @stapxs/umami-logger-typescript 会把 axios（约 50KB）一起
 * 拽进首屏包；而统计只在用户没关追踪时才真正初始化，所以包成用到时再加载。
 * 加载结果会被模块缓存，后续调用直接命中。
 */
export async function getUmami() {
    const m = await import('@stapxs/umami-logger-typescript')
    return m.default
}

export function trackEvent(event: string, data?: { [key: string]: any }) {
    void getUmami().then((umami) => umami.trackEvent(event, data))
}

export function trackPageView(path: string) {
    void getUmami().then((umami) => umami.trackPageView(path))
}

export function trackIdentify(data: { [key: string]: any }) {
    void getUmami().then((umami) => umami.trackIdentify(data))
}

export function initializeUmami(config: any) {
    void getUmami().then((umami) => umami.initialize(config))
}
