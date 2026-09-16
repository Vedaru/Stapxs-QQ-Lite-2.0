/**
 * @FileDescription: 本地历史消息工具（Tauri 平台）
 * @Description:
 *   封装对 Tauri 后端 db_* 命令的调用，提供类型安全的本地 SQLite 历史消息读写接口。
 *   非 Tauri 平台调用时会静默 no-op / 返回空数组，不影响其他平台逻辑。
 */

import { backend } from '@renderer/runtime/backend'
import {
    getMsgRawTxt,
    getImageInfo,
    readImageSizeFromBase64,
    rememberImageSize,
    preloadImageSize,
    extractImageUrlsFromMsgs,
    harvestImageSizesFromMsgs,
    firstScreenMsgCount,
} from './msgUtil'
import { Logger } from '../base'
import { useSettingsStore } from '@renderer/state/settings'
import { useAuthStore } from '@renderer/state/auth'

const logger = new Logger()

// ── 类型定义（与 Rust MsgRecord 对应） ───────────────────────────

export interface LocalMsgRecord {
    /** Bot 侧的消息 ID */
    message_id: string
    /** 会话 ID（group_id 或 user_id） */
    chat_id: number
    /** 会话类型："group" | "private" */
    chat_type: string
    /** 发送者 user_id */
    sender_id: number
    /** 发送者昵称（card 优先，fallback nickname） */
    sender_name: string | null
    /** 消息序号（并非所有 Bot 都提供，可能为 null） */
    seq: number | null
    /** 消息时间戳（秒，Bot 原始值） */
    time: number
    /** JSON 序列化的 MsgItemElem[] 消息段数组 */
    message: string
    /** 纯文本摘要 */
    raw_message: string | null
    /** 是否已撤回 */
    revoked: boolean
}

function isTauriHistoryAvailable(): boolean {
    const settingsStore = useSettingsStore()
    return backend.type === 'tauri' && settingsStore.sysConfig.enable_local_history === true
}

async function callDbRecordList(
    selfId: string | number,
    command: string,
    payload: Record<string, any>,
    errorTag: string,
    waitCountOf?: (msgs: any[]) => number,
): Promise<any[]> {
    if (!isTauriHistoryAvailable()) return []
    try {
        const records: LocalMsgRecord[] = await backend.call(
            undefined,
            command,
            true,
            { selfId: String(selfId), ...payload },
        )
        const msgs = (records ?? []).map(deserializeRecord)
        // 在这一页交给 store 之前把图片尺寸补上 —— 它必须发生在这些行挂载之前，
        // 见 prewarmImageSizes 的注释。只有「会落在视口里」的那一页需要等（dbGetLatest
        // 传 firstScreenMsgCount），其余调用不传就是 0 = 后台量、不等。
        await prewarmImageSizes(selfId, msgs, waitCountOf ? waitCountOf(msgs) : 0)
        return msgs
    } catch (e) {
        logger.error(e as unknown as Error, errorTag)
        return []
    }
}

/**
 * 把这一页消息里还没量到尺寸的图片，从本地缓存里量出来。
 *
 * 这些行是从 DB 里翻出来的，消息段没有宽高、本地缓存里存的是字节，所以刚出生时
 * MsgBody.preSize 一个占位盒都交不出来 —— 每张图都要等解码完才把那一行撑开，而这些
 * 行往往正好落在视口里（上拉翻历史就是这么翻的），撑开量只能靠滚动去补，可是一次
 * 滚动只能锚住撑开行的一侧，在视口里撑开的那种补不回来（实测：视口内的图解码时上面
 * 整屏内容被推走 394px，怎么补都差一截）。
 *
 * 所以尺寸得赶在这些行挂载之前就进 imageInfos：这一步跑的时机正是「还没交给 store」，
 * 量到之后 preSize 会给出正确的 aspect-ratio，出生框就是最终框，解码只是往占好的框里
 * 填内容，列表高度自始至终不变。字节本来就在本地（图片缓存），读出来扫一眼文件头而已，
 * 不解码、不联网；没缓存的图（远程地址、缓存被清过）量不到就照旧。
 *
 * 本地读不到的（图没进过缓存、缓存被清掉、缓存功能关着）接着交给网络预加载 —— 这条
 * 兜底不能省：本地历史正是最容易出现「一大屏图同时在视口里解码」的场景，只靠本地
 * 缓存量不到的那部分会原地退回抖动。
 */
async function prewarmImageSizes(
    selfId: string | number,
    msgs: any[],
    waitCount = 0,
): Promise<void> {
    if (!isTauriHistoryAvailable()) return

    // 段上自带宽高的先捡出来，这些图下去既不用读本地缓存也不用联网
    harvestImageSizesFromMsgs(msgs)

    const pending = [...new Set(extractImageUrlsFromMsgs(msgs))]
        .filter(url => !getImageInfo(url))
    if (pending.length === 0) return

    // 开了手动加载就不替他下载，占位块才是他的入口；本地那点字节照读不误（不联网）
    const settingsStore = useSettingsStore()
    const allowNetwork = settingsStore.sysConfig.opt_no_auto_load_image !== true

    // 本地读和网络预加载是**逐张**接力、而不是先等完整轮本地读再统一转网络。一轮
    // dbGetImage 要把整张图的 base64 搬过 IPC，一页图读下来是实打实的一段等待；以前
    // 网络那一半要等这段全部走完才开始，等于两段串着跑。现在每张图各自本地读不到就
    // 立刻开下载，网络这段和其余图片的本地读重叠 —— 整页的等待从「本地轮 + 网络轮」
    // 压成两者的较大值。
    const measure = async (url: string) => {
        try {
            const cached = await dbGetImage(selfId, await hashUrl(url))
            if (cached?.data) {
                const size = readImageSizeFromBase64(cached.data)
                if (size) {
                    rememberImageSize(url, size.w, size.h)
                    return
                }
            }
        } catch {
            // 读不到不影响其余图片，交给下面走网络
        }
        if (allowNetwork) await preloadImageSize(url)
    }

    // 整页都会量，但**默认一张都不等**：尺寸迟早会进 imageInfos，等的只是那些一挂上去
    // 就落在视口里的行。理由和 msg.ts saveMsg 里那段一样 —— 列表是 column-reverse、原点
    // 钉在最新一条上，视口**上方**长高推不动用户正在看的东西，只有视口里的会长给人看见。
    // 所以「打开会话」这一页传 firstScreenMsgCount 等首屏，翻页 / 搜索这些整批落在视口
    // 以外的调用传 0，后台走完即可，不占交给 store 之前的那段等待。
    //
    // 顺序要紧，和 msgUtil.preloadImageSizesForMsgs 是同一个理由：本地读是排队走的
    // （一轮 dbGetImage 要把整张图的 base64 搬过 IPC），量不到的走网络预加载，而网络那边
    // 也是同源排队。整页一起点着的话，首屏那几张恰好排在整页的最末尾 —— 前面几十张视口外
    // 的图读完之前，它们连开始都开始不了，等待窗口明明只有两三张，等出来的却是整页的耗时。
    // 所以先量完视口里那一撮，剩下的等它落定再开始。
    const tail = new Set<string>()
    if (waitCount > 0) {
        for (const url of extractImageUrlsFromMsgs(msgs.slice(Math.max(0, msgs.length - waitCount)))) {
            tail.add(url)
        }
    }

    await Promise.all(pending.filter(url => tail.has(url)).map(url => measure(url)))
    for (const url of pending) {
        if (!tail.has(url)) void measure(url)
    }
}

async function callDb(
    selfId: string | number,
    command: string,
    payload: Record<string, any>,
    fallback: any,
    errorTag: string,
): Promise<any> {
    if (!isTauriHistoryAvailable()) return fallback
    try {
        return await backend.call(
            undefined,
            command,
            true,
            { selfId: String(selfId), ...payload },
        )
    } catch (e) {
        logger.error(e as unknown as Error, errorTag)
        return fallback
    }
}

function serializeMsgSegments(segments: any[] | undefined): string {
    try {
        return JSON.stringify(segments ?? [])
    } catch {
        return '[]'
    }
}

function deserializeMsgSegments(serialized: string): any[] {
    try {
        return JSON.parse(serialized)
    } catch {
        return []
    }
}

function computeRawMessage(msg: any): string | null {
    try {
        return getMsgRawTxt(msg) || msg.raw_message || null
    } catch {
        return msg.raw_message ?? null
    }
}

function deriveChatId(selfId: string | number, msgs: any[]): number | undefined {
    const firstMsg = msgs[0]
    let chatId: number | undefined = firstMsg?.infoList?.group_id ?? firstMsg?.infoList?.target_id
    if (chatId != null) return Number(chatId)

    for (const item of msgs) {
        if (item?.infoList?.sender != null && String(item.infoList.sender) !== String(selfId)) {
            chatId = Number(item.infoList.sender)
            break
        }
    }
    return chatId
}

export function ensureChatIdOnMsgs(selfId: string | number, msgs: any[]): any[] {
    const chatId = deriveChatId(selfId, msgs)
    if (chatId == null) return msgs

    return msgs.map((item: any) => {
        if (!item?.infoList) return item
        if (item.infoList.group_id != null || item.infoList.target_id != null) {
            return item
        }
        return {
            ...item,
            infoList: {
                ...item.infoList,
                target_id: chatId,
            },
        }
    })
}

// ── 辅助：将运行时消息对象转换为 LocalMsgRecord ──────────────────

/**
 * 将已经过 msgPreprocess 处理的消息对象转成可存入 DB 的 LocalMsgRecord。
 * 若必要字段缺失则返回 null，调用方需过滤掉 null。
 */
export function msgToRecord(msg: any): LocalMsgRecord | null {
    const messageId = msg.message_id
    if (!messageId) return null

    const chatId: number = msg.infoList.group_id ?? msg.infoList.target_id
    if (chatId == null) return null

    const chatType: string =
        msg.message_type ?? (msg.group_id != null ? 'group' : 'private')
    const senderId: number = msg.infoList.sender
    if (senderId == null) return null

    const senderName: string | null =
        (msg.sender?.card && msg.sender.card !== '') ? msg.sender.card : (msg.sender?.nickname ?? null)

    const rawMessage = computeRawMessage(msg)
    const messageSerialized = serializeMsgSegments(msg.message)

    return {
        message_id: String(messageId),
        chat_id: Number(chatId),
        chat_type: chatType,
        sender_id: Number(senderId),
        sender_name: senderName,
        seq: msg.seq_id != null ? Number(msg.seq_id) : null,
        time: Number(msg.time),
        message: messageSerialized,
        raw_message: rawMessage,
        revoked: false,
    }
}

// ── 读写接口 ──────────────────────────────────────────────────────

/**
 * 批量将消息保存到本地 SQLite（已有的 message_id 自动忽略，不覆盖）。
 *
 * @param selfId  当前登录账号 uin
 * @param msgs    已完成预处理的消息对象数组（来自 chatStore.messageList 或 newMsg）
 */
export async function dbSaveMessages(selfId: string | number, msgs: any[]): Promise<void> {
    if (!isTauriHistoryAvailable()) return

    const persistableMsgs = ensureChatIdOnMsgs(selfId, msgs)
    const records: LocalMsgRecord[] = persistableMsgs
        .map(msgToRecord)
        .filter((r): r is LocalMsgRecord => r !== null)

    if (records.length === 0) {
        logger.error(null, '[LocalHistory] dbSaveMessages: 没有有效消息可保存')
        return
    }

    try {
        await backend.call(undefined, 'db:saveMessages', true, {
            selfId: String(selfId),
            messages: records,
        })
    } catch (e) {
        logger.error(e as unknown as Error, '[LocalHistory] dbSaveMessages 失败')
    }
}

export async function saveMessagesWithSideEffects(selfId: string | number, msgs: any[]): Promise<void> {
    const settingsStore = useSettingsStore()
    const persistableMsgs = ensureChatIdOnMsgs(selfId, msgs)
    await dbSaveMessages(selfId, persistableMsgs)
    if (settingsStore.sysConfig.disable_local_history_image_cache === true) return
    cacheImagesFromMsgs(selfId, persistableMsgs).catch(() => {})
}

/**
 * 获取某会话最新 n 条本地消息（正序，revoked 消息不包含）。
 *
 * 这是唯一一个「拿到的这一页会出现在视口里」的读取（打开会话时垫在最新消息的位置），
 * 所以也只有它需要等首屏图片量完尺寸，见 prewarmImageSizes。
 *
 * @returns 消息段数组已反序列化的消息对象数组，出错或非 Tauri 返回空数组
 */
export async function dbGetLatest(
    selfId: string | number,
    chatId: number,
    n: number,
): Promise<any[]> {
    return callDbRecordList(
        selfId,
        'db:getLatest',
        { chatId, n },
        '[LocalHistory] dbGetLatest 失败',
        firstScreenMsgCount,
    )
}

/**
 * 获取锚点消息之前（更旧）的 n 条，不含锚点本身，正序返回。
 *
 * 典型用途：上拉加载更多历史。这一页整个接在视口远端（更旧的那一头），长高推不动用户
 * 正在看的东西，所以图片只后台量、不等（见 prewarmImageSizes 的默认值）。
 */
export async function dbGetBefore(
    selfId: string | number,
    chatId: number,
    messageId: string,
    n: number,
): Promise<any[]> {
    return callDbRecordList(selfId, 'db:getBefore', { chatId, messageId, n }, '[LocalHistory] dbGetBefore 失败')
}

/**
 * 获取某个时间戳之前（更旧）的 n 条消息，正序返回。
 */
export async function dbGetBeforeByTime(
    selfId: string | number,
    chatId: number,
    beforeTime: number,
    n: number,
): Promise<any[]> {
    return callDbRecordList(selfId, 'db:getBeforeByTime', { chatId, beforeTime, n }, '[LocalHistory] dbGetBeforeByTime 失败')
}

/**
 * 获取锚点消息之后（更新）的 n 条，不含锚点本身，正序返回。
 *
 * 典型用途：从指定消息位置向后展开查看。
 */
export async function dbGetAfter(
    selfId: string | number,
    chatId: number,
    messageId: string,
    n: number,
): Promise<any[]> {
    return callDbRecordList(selfId, 'db:getAfter', { chatId, messageId, n }, '[LocalHistory] dbGetAfter 失败')
}

/**
 * 将指定 message_id 在本地 DB 中标记为已撤回。
 *
 * @returns 是否命中（true = DB 中存在该消息并更新成功）
 */
export async function dbRevokeMessage(
    selfId: string | number,
    messageId: string,
): Promise<boolean> {
    return callDb(selfId, 'db:revokeMessage', { messageId }, false, '[LocalHistory] dbRevokeMessage 失败')
}

/**
 * 在指定会话的本地 DB 中按关键词搜索消息（对 raw_message 做 LIKE 匹配）。
 *
 * 结果进的是搜索面板的列表（Chat.vue 的 tags.search.list），不是消息列表，所以这里
 * 不等图片尺寸 —— 等它只会让每敲一个字都卡在几张图的下载上。
 *
 * @returns 匹配消息列表（正序），出错或非 Tauri 返回空数组
 */
export async function dbSearchMessages(
    selfId: string | number,
    chatId: number,
    query: string,
): Promise<any[]> {
    if (!isTauriHistoryAvailable() || !query) return []
    return callDbRecordList(selfId, 'db:searchMessages', { chatId, query }, '[LocalHistory] dbSearchMessages 失败')
}

export async function dbGetStats(
    selfId: string | number,
): Promise<{ totalMessages: number; imageCount: number; imageCacheBytes: number; dbSizeBytes: number } | null> {
    return callDb(selfId, 'db:getStats', {}, null, '[LocalHistory] dbGetStats 失败')
}

/**
 * 计算 URL 的 SHA-256 十六进制摘要，用作图片缓存的唯一键。
 */
export async function hashUrl(url: string): Promise<string> {
    const data = new TextEncoder().encode(url)
    const buf = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
}

/**
 * 将图片缓存到本地加密数据库。
 * `data` 为 base64 编码的原始图片字节。
 */
export async function dbCacheImage(
    selfId: string | number,
    urlHash: string,
    mimeType: string,
    data: string,
): Promise<void> {
    if (!isTauriHistoryAvailable()) return

    try {
        await backend.call(undefined, 'db:cacheImage', true, {
            selfId: String(selfId),
            urlHash,
            mimeType,
            data,
        })
    } catch (e) {
        logger.error(e as unknown as Error, '[LocalHistory] dbCacheImage 失败')
    }
}

/**
 * 从本地数据库读取已缓存的图片。
 * 返回 `{ mimeType, data }` （data 为 base64），未缓存则返回 `null`。
 */
export async function dbGetImage(
    selfId: string | number,
    urlHash: string,
): Promise<{ mimeType: string; data: string } | null> {
    return callDb(selfId, 'db:getImage', { urlHash }, null, '[LocalHistory] dbGetImage 失败')
}

export interface DbClearImagesProgress {
    selfId: string
    total: number
    deleted: number
    batchDeleted: number
    progress: number
    done: boolean
}

export interface DbClearImagesResult {
    total: number
    deleted: number
    batches: number
}

export async function dbClearImages(
    selfId: string | number,
    onProgress?: (progress: DbClearImagesProgress) => void,
): Promise<DbClearImagesResult> {
    if (!isTauriHistoryAvailable()) {
        return { total: 0, deleted: 0, batches: 0 }
    }

    let unlisten: undefined | (() => void | Promise<void>)
    if (onProgress && backend.type === 'tauri') {
        const { listen } = await import('@tauri-apps/api/event')
        unlisten = await listen<DbClearImagesProgress>('db:clearImagesProgress', (event) => {
            const payload = event.payload
            if (!payload) return
            if (String(payload.selfId) !== String(selfId)) return
            onProgress(payload)
        })
    }

    try {
        const result = await callDb(
            selfId,
            'db:clearImages',
            {},
            { total: 0, deleted: 0, batches: 0 },
            '[LocalHistory] dbClearImages 失败',
        )
        return {
            total: Number(result?.total ?? 0),
            deleted: Number(result?.deleted ?? 0),
            batches: Number(result?.batches ?? 0),
        }
    } finally {
        if (unlisten) await unlisten()
    }
}

// ── 内部工具 ──────────────────────────────────────────────────────

/**
 * 遍历消息列表，将所有图片段下载并缓存到本地数据库。
 * 已缓存的图片（url_hash 命中）不会重复下载。
 */
async function cacheImagesFromMsgs(selfId: string | number, msgs: any[]): Promise<void> {
    if (!isTauriHistoryAvailable()) return
    const urls = extractImageUrlsFromMsgs(msgs)
    for (const url of urls) {
        try {
            await cacheSingleImage(selfId, url)
        } catch {
            // 单张图片失败不影响其余图片
        }
    }
}

async function downloadImageViaProxy(url: string): Promise<{ mimeType: string; base64: string } | null> {
    // 走 backend.proxyUrl 而不是就地拼一遍：代理地址只有一处定义（还带着 localhost /
    // 127.0.0.1 这类必须和 Rust 那边的 bind 地址对齐的细节），拼两份迟早拼岔。
    const fetchUrl = backend.proxyUrl(url)

    const resp = await fetch(fetchUrl)
    if (!resp.ok) return null

    const mimeType = resp.headers.get('Content-Type')?.split(';')[0]?.trim() ?? 'image/jpeg'
    const buffer = await resp.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
    const base64 = btoa(binary)
    return { mimeType, base64 }
}

async function cacheSingleImage(selfId: string | number, url: string): Promise<void> {
    const urlHash = await hashUrl(url)
    const existing = await dbGetImage(selfId, urlHash)
    if (existing) return

    const downloaded = await downloadImageViaProxy(url)
    if (!downloaded) return

    // 字节已经在手上，顺手量一次尺寸写进尺寸表：让「图进了本地缓存」和「客户端知道
    // 它的比例」同时发生。这样以后翻到这一页时 preSize 直接给得出占位框，不必等到解码
    // （prewarmImageSizes 是读路径的兜底，写入时就量掉就不用每次读都重解析一遍）。
    const size = readImageSizeFromBase64(downloaded.base64)
    if (size) rememberImageSize(url, size.w, size.h)

    await dbCacheImage(selfId, urlHash, downloaded.mimeType, downloaded.base64)
}

/**
 * 将 DB 返回的 LocalMsgRecord 还原为与 chatStore.messageList 兼容的消息对象。
 */
function deserializeRecord(record: LocalMsgRecord): any {
    const authStore = useAuthStore()
    const message = deserializeMsgSegments(record.message)

    // 判断是否为自己发送的消息，还原 post_type
    const isSelf = record.sender_id === Number(authStore.loginInfo.uin)
    const postType = isSelf ? 'message_sent' : 'message'

    // 群消息：sender_name 来自 card，私聊来自 nickname
    const isGroup = record.chat_type === 'group'
    const sender = isGroup ? { user_id: record.sender_id, card: record.sender_name ?? '', nickname: record.sender_name ?? '' } : { user_id: record.sender_id, card: '', nickname: record.sender_name ?? '' }
    const infoList = {
        message_id: record.message_id,
        private_id: isGroup ? undefined : record.chat_id,
        group_id: isGroup ? record.chat_id : undefined,
        target_id: isGroup ? undefined : record.chat_id,
        sender: record.sender_id,
    }

    return {
        post_type: postType,
        message_id: record.message_id,
        message_type: record.chat_type,
        // 根据 chat_type 恢复对应的 id 字段
        ...(isGroup ? { group_id: record.chat_id } : { user_id: record.chat_id }),
        sender,
        time: record.time,
        message,
        infoList,
        raw_message: record.raw_message ?? '',
        revoked: record.revoked,
        // 消息序列号（并非所有 Bot 都提供，可为 null）
        ...(record.seq != null ? { message_seq: record.seq, seq_id: record.seq } : {}),
        // 标记来源为本地缓存，业务层可按需用此字段区分
        _from_local_db: true,
    }
}
