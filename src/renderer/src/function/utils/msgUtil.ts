import jp from 'jsonpath'
import app from '@renderer/main'
import option from '@renderer/function/option'

import { Logger, PopInfo, PopType } from '@renderer/function/base'
import { useSettingsStore } from '@renderer/state/settings'
import { v4 as uuid } from 'uuid'
import { Connector } from '@renderer/function/connect'
import {
    BotMsgType,
    UserFriendElem,
    UserGroupElem,
} from '../elements/information'
import { sendStatEvent } from './appUtil'
import { ref } from 'vue'
import { backend } from '@renderer/runtime/backend'
import { useContactStore } from '@renderer/state/contact'
import { useUIStore } from '@renderer/state/ui'
import { useAuthStore } from '@renderer/state/auth'
import { useChatStore } from '@renderer/state/chat'
import {
    findSessionContact,
    getSessionId,
} from './sessionUtil'

const logger = new Logger()

/**
 * 根据 JSON Path 映射数据返回需要的内容体
 * @param msg
 * @param map
 * @returns
 */
export function getMsgData(
    name: string,
    msg: { [key: string]: any },
    map: string | { [key: string]: any },
) {
    let back = undefined as any
    // 解析数据
    if (map != undefined) {
        if (typeof map == 'string' || map.source != undefined) {
            try {
                back = jp.query(
                    msg,
                    replaceJPValue(typeof map == 'string' ? map : map.source),
                )
                if (back && typeof map != 'string' && map.list != undefined) {
                    const backList = [] as any[]
                    back.forEach((item) => {
                        const itemObj = {} as any
                        Object.keys(map.list).forEach((key: string) => {
                            if (map.list[key] && map.list[key] != '') {
                                if (map.list[key].startsWith('/'))
                                    itemObj[key] =
                                        item[map.list[key].substring(1)]
                                else {
                                    let nameKey = map.list[key]
                                    let regexKey = null
                                    if (nameKey.indexOf('@') > -1) {
                                        const [name, key] = nameKey.split('@')
                                        nameKey = name
                                        regexKey = key
                                    }
                                    itemObj[key] = jp.query(
                                        item,
                                        replaceJPValue(nameKey),
                                    )
                                    if (regexKey != null) {
                                        const regex = new RegExp(regexKey)
                                        const match = itemObj[key].match(regex)
                                        if (match != null) {
                                            itemObj[key] = match[0]
                                        }
                                    }
                                }
                            }
                        })
                        backList.push(itemObj)
                    })
                    back = backList
                }
            } catch (ex) {
                logger.error(
                    ex as Error,
                    `解析消息 JSON 错误：${name} -> ${map}`,
                )
            }
        } else {
            const data = {} as { [key: string]: any }
            Object.keys(map).forEach((key) => {
                if (
                    map[key] != undefined &&
                    map[key] !== '' &&
                    !key.startsWith('_')
                )
                    try {
                        data[key] = jp.query(msg, replaceJPValue(map[key]))[0]
                    } catch (ex) {
                        logger.error(
                            ex as Error,
                            `解析 JSON 错误：${name} -> ${map}`,
                        )
                    }
            })
            back = [data]
        }
    }
    return back
}
function replaceJPValue(jpStr: string) {
    const authStore = useAuthStore()
    return jpStr.replaceAll('<uin>', authStore.loginInfo.uin)
}

/**
 * 将一个消息体列表组装为基础消息列表便于解析（message 消息体可能不正确）
 * @param msgList
 * @param map
 * @returns
 */
export function buildMsgList(msgList: { [key: string]: any }): {
    [key: string]: any
} {
    const authStore = useAuthStore()
    const path = jp.parse(authStore.jsonMap.message_list.source)
    const keys = [] as string[]
    path.forEach((item) => {
        if (item.expression.value != '*' && item.expression.value != '$') {
            keys.push(item.expression.value)
        }
    })
    const result = {} as any
    let acc = result
    keys.forEach((key, index) => {
        if (index === keys.length - 1) {
            acc[key] = msgList
        } else {
            acc[key] = {}
        }
        acc = acc[key]
    })
    return result
}

export function parseMsgList(
    list: any,
    map: string,
    valueMap: { [key: string]: any },
): any[] {
    const uiStore = useUIStore()
    const authStore = useAuthStore()
    if (!Array.isArray(list) || list.length === 0 || !list[0]) {
        return []
    }
    // 判断消息类型
    if (typeof list[0].message == 'string') {
        uiStore.msgType = BotMsgType.CQCode
    } else {
        uiStore.msgType = BotMsgType.Array
    }
    // 消息类型的特殊处理
    switch (uiStore.msgType) {
        case BotMsgType.CQCode: {
            // 这儿会默认处理成 oicq2 的格式，所以 CQCode 消息请使用 oicq2 配置文件修改
            for (let i = 0; i < list.length; i++) {
                list[i] = parseCQ(list[i])
            }
            break
        }
        case BotMsgType.Array: {
            // 非扁平化消息体，这儿会取 _type 后半段的 JSON Path 将结果并入 message
            for (let i = 0; i < list.length; i++) {
                let msgList = list[i].message
                if (msgList == undefined) {
                    msgList = list[i].content
                }
                if (!Array.isArray(msgList)) {
                    continue
                }
                for (let j = 0; j < msgList.length; j++) {
                    const data = getMsgData(
                        'message_list_message',
                        msgList[j],
                        map,
                    )
                    // 如果 data 里有 type 字段，改成 type_item
                    if (data[0] && data[0]['type'] != undefined) {
                        data[0]['type_item'] = data[0]['type']
                        delete data[0]['type']
                    }
                    if (data != undefined && data.length == 1) {
                        msgList[j] = Object.assign(msgList[j], data[0])
                    }
                }
            }
        }
    }
    // 消息字段的标准化特殊处理
    if (valueMap != undefined) {
        for (let i = 0; i < list.length; i++) {
            Object.entries(valueMap).forEach(([type, values]) => {
                Object.entries(values).forEach(([key, value]) => {
                    let content = list[i].message
                    if (content == undefined) {
                        content = list[i].content
                    }
                    if (!Array.isArray(content)) {
                        return
                    }
                    content.forEach((item: any) => {
                        if (item.type == type) {
                            item[key] = jp.query(item, value as string)[0]
                        }
                        // 顺便把没用的 data 删了，这边要注意 item.data 必须是个对象
                        // 因为有些消息类型的 data 就叫 data
                        if (typeof item.data == 'object') {
                            delete item.data
                        }
                    })
                    // 其他处理
                    if (list[i].content != undefined) {
                        // 把 content 改成 message
                        list[i].message = content
                        delete list[i].content
                        // 添加一个 sender.user_id 为 user_id
                        list[i].sender = {
                            user_id: list[i].user_id,
                            nickname: list[i].nickname,
                        }
                    }
                })
            })
            // 补充 infoList
            const infoList = getMsgData('message_info', list[i], authStore.jsonMap.message_info)
            if (infoList != undefined) {
                list[i].infoList = infoList[0]
            }
        }
    }
    return list
}

/**
 * 将消息对象处理为扁平字符串
 * @param message 待处理的消息对象
 * @returns 字符串
 */
export function getMsgRawTxt(data: any): string {
    const { $t } = app.config.globalProperties
    const chatStore = useChatStore()

    const message = data.message as [{ [key: string]: any }]
    const fromId = data.group_id ?? data.user_id
    let back = ''
    for (let i = 0; i < message.length; i++) {
        try {
            switch (message[i].type) {
                case 'at':
                    if (message[i].text == undefined) {
                        // 群内才可以 at，如果 at 消息中没有 text 字段
                        // 尝试去群成员列表中找到对应的昵称，群成员列表只在当前打开的群才有
                        if (
                            chatStore.chatInfo.show.id == fromId &&
                            chatStore.chatInfo.info.group_members
                        ) {
                            const user =
                                chatStore.chatInfo.info.group_members.find(
                                    (item) => item.user_id == message[i].qq,
                                )
                            if (user) {
                                back +=
                                    '@' +
                                    (user.card && user.card != '' ? user.card : user.nickname)
                                break
                            }
                        }
                        break
                    }
                // eslint-disable-next-line
                case 'text':
                    back += message[i].text
                        .replaceAll('\n', ' ')
                        .replaceAll('\r', ' ')
                    break
                case 'forward':
                    back += '[' + $t('聊天记录') + ']'
                    break
                case 'face':
                    back += '[' + $t('表情') + ']'
                    break
                case 'bface':
                    back += message[i].text
                    break
                case 'image':
                    back +=
                        (!message[i].summary || message[i].summary == '') ? '[' + $t('图片') + ']' : message[i].summary
                    break
                case 'record':
                    back += '[' + $t('语音') + ']'
                    break
                case 'video':
                    back += '[' + $t('视频') + ']'
                    break
                case 'file':
                    back += '[' + $t('文件') + ']' + message[i].name
                    break
                case 'json': {
                    try {
                        back += JSON.parse(message[i].data).prompt
                    } catch (error) {
                        back += '[' + $t('卡片消息') + ']'
                    }
                    break
                }
                case 'xml': {
                    let name = message[i].data.substring(
                        message[i].data.indexOf('<source name="') + 14,
                    )
                    name = name.substring(0, name.indexOf('"'))
                    back += '[' + name + ']'
                    break
                }
            }
        } catch (error) {
            logger.error(
                error as Error,
                '解析消息短格式错误：' + JSON.stringify(message[i]),
            )
        }
    }
    return back
}

/**
 * 将消息对象转换为 CQCode
 * @param data
 * @returns CQCode 字符串
 */
export function parseJSONCQCode(data: any) {
    let back = ''
    data.forEach((item: any) => {
        if (item.type != 'text') {
            let body = '[CQ:' + item.type + ','
            Object.keys(item).forEach((key: any) => {
                body += `${key}=${item[key]},`
            })
            body = body.substring(0, body.length - 1) + ']'
            back += body
        } else {
            back += item.text
        }
    })
    return back
}

/**
 * 将扁平的 CQCode 消息处理成消息对象
 * @param msg CQCode 消息
 * @returns 消息对象
 */
export function parseCQ(data: any) {
    let msg = data.message as string
    // 将纯文本也处理为 CQCode 格式
    // PS：这儿不用担心方括号本身，go-cqhttp 会把它转义掉
    let reg = /^[^\]]+?\[|\].+\[|\][^[]+$|^[^[\]]+$/g
    const textList = msg.match(reg)
    if (textList !== null) {
        textList.forEach((item) => {
            item = item.replace(']', '').replace('[', '')
            msg = msg.replace(item, `[CQ:text,text=${item}]`)
        })
    }
    // 拆分 CQCode
    reg = /\[.+?\]/g
    msg = msg.replaceAll('\n', '\\n')
    const list = msg.match(reg)
    // 处理为 object
    const back: { [ket: string]: any }[] = []
    reg = /\[CQ:([^,]+),(.*)\]/g
    if (list !== null) {
        list.forEach((item) => {
            if (item.match(reg) !== null) {
                const info: { [key: string]: any } = { type: RegExp.$1 }
                RegExp.$2.split(',').forEach((key: string) => {
                    const kv = [] as string[]
                    kv.push(key.substring(0, key.indexOf('=')))
                    // 对 html 转义字符进行反转义
                    const a = document.createElement('a')
                    a.innerHTML = key.substring(key.indexOf('=') + 1)
                    kv.push(a.innerText)
                    info[kv[0]] = kv[1]
                })
                // 对文本消息特殊处理
                if (info.type == 'text') {
                    info.text = RegExp.$2
                        .substring(RegExp.$2.lastIndexOf('=') + 1)
                        .replaceAll('\\n', '\n')
                    // 对 html 转义字符进行反转义
                    const a = document.createElement('a')
                    a.innerHTML = info.text
                    info.text = a.innerText
                }
                // 对回复消息进行特殊处理
                if (info.type == 'reply') {
                    data.source = {
                        user_id: info.user_id,
                        seq: info.seq,
                        message: info.message,
                    }
                } else {
                    back.push(info)
                }
            }
        })
    }
    logger.debug('解析 CQ 消息结果: ' + JSON.stringify(back))
    data.message = back
    return data
}

/**
* 发送消息
* @param id 发送对象的 id
* @param type 发送对象的类型
* @param msg 消息体
* @param preShow 是否消息预显
* @param echo 回显的事件名
*/
export function sendMsgRaw(
    id: string,
    type: string,
    msg: string | any[] | undefined,
    preShow = false,
    echo = 'sendMsgBack',
) {
    const chatStore = useChatStore()
    const authStore = useAuthStore()
    const contactStore = useContactStore()
    const uiStore = useUIStore()
    // 如果消息为空则不发送
    if (msg == undefined || msg == '' || (Array.isArray(msg) && msg.length == 0)) {
        return
    }
    // 预发送消息
    // 将消息构建为完整消息体先显示出去
    const msgUUID = uuid()
    if (preShow) {
        const preShowMsg = JSON.parse(JSON.stringify(msg));
        preShowMsg.forEach((item: any) => {
            // 对 base64 图片做特殊处理
            if (item.type == 'image') {
                if (item.file.startsWith('base64://')) {
                    const b64Str = (item.file as string).substring(9)
                    item.url = 'data:image/png;base64,' + b64Str
                    // 字节就在手上，顺手把原始宽高量出来记进尺寸表 —— 下面这条预显气泡
                    // 拿 item.url 当键，量过之后它出生就带着确定的比例框（MsgBody 的
                    // preSize），解码只是往占好的框里填内容。发的图往往正好出现在视口
                    // 里，那一下撑开没有任何补滚动的位置能救，只能提前占住。
                    // 认不出的格式返回 null，照旧等解码时量。
                    const size = readImageSizeFromBase64(b64Str)
                    if (size) rememberImageSize(item.url, size.w, size.h)
                } else {
                    item.url = item.file
                }
            }
        })
        const showMsg = {
            revoke: true,
            fake_msg: true,
            message_id: msgUUID,
            fake_message_id: msgUUID,       // 用来作为这条消息的唯一标识，防止 message_id 刷新导致的闪烁
            message_type: chatStore.chatInfo.show.type,
            time: parseInt(String(new Date().getTime() / 1000)),
            post_type: 'message',
            sender: {
                user_id: authStore.loginInfo.uin,
                nickname: authStore.loginInfo.nickname,
            },
            message: preShowMsg,
        } as { [key: string]: any }
        showMsg.raw_message = getMsgRawTxt(showMsg)

        if (showMsg.message_type == 'group') {
            showMsg.group_id = chatStore.chatInfo.show.id
        } else {
            showMsg.user_id = chatStore.chatInfo.show.id
        }
        chatStore.messageList = chatStore.messageList.concat([showMsg])

        // 发送方不一定会上报自身消息事件，先用预发送消息同步会话预览。
        const sessionId = Number(String(id).split('/')[0])
        const session = contactStore.baseOnMsgList.get(sessionId) ??
            findSessionContact(contactStore.userList, sessionId)
        if (session) {
            const raw = getMsgRawTxt(showMsg)
            const senderName = authStore.loginInfo.nickname
            Object.assign(session, {
                message_id: showMsg.message_id,
                raw_msg: type === 'group' && senderName ? `${senderName}: ${raw}` : raw,
                raw_msg_base: raw,
                time: showMsg.time * 1000,
            })
            contactStore.baseOnMsgList.set(sessionId, session)
            updateBaseOnMsgList()
        }
    }
    // 检查消息体是否需要处理
    if (uiStore.msgType == BotMsgType.Array) {
        if (msg && typeof msg != 'string') {
            const newMsg = [] as any
            msg.forEach((item) => {
                const newResult = {} as { [key: string]: any }
                newResult.type = item.type
                newResult.data = item
                delete newResult.data.type
                // 特殊处理，如果 newResult.data 里有 _type 字段，给它改成 type
                if (newResult.data._type != undefined) {
                    newResult.data.type = newResult.data._type
                    delete newResult.data._type
                }
                newMsg.push(newResult)
            })
            msg = newMsg
        }
    }
    if (msg !== undefined && msg.length > 0) {
        if (authStore.jsonMap.name === 'Lagrange.OneBot') {
            lgrSendMsg(id, msg, type, echo + '_uuid_' + msgUUID)
            sendStatEvent('send_msg', { type: type })
            return
        }
        switch (type) {
            case 'group':
                Connector.send(
                    authStore.jsonMap.message_list.name_group_send ??
                    'send_msg',
                    { group_id: id, message: msg },
                    echo + '_uuid_' + msgUUID,
                )
                break
            case 'user': {
                if (String(id).indexOf('/') > 1) {
                    Connector.send(
                        authStore.jsonMap.message_list.name_temp_send ??
                        'send_temp_msg',
                        {
                            user_id: id.split('/')[0],
                            group_id: id.split('/')[1],
                            message: msg,
                        },
                        echo + '_uuid_' + msgUUID,
                    )
                } else {
                    Connector.send(
                        authStore.jsonMap.message_list.name_user_send ??
                        'send_msg',
                        { user_id: id, message: msg },
                        echo + '_uuid_' + msgUUID,
                    )
                }
                break
            }
        }
        sendStatEvent('send_msg', { type: type })
    }
}

export function updateLastestHistory(item: UserFriendElem & UserGroupElem) {
    const authStore = useAuthStore()
    // 发起获取历史消息请求
    const type = item.user_id ? 'user' : 'group'
    const id = item.user_id ? item.user_id : item.group_id
    let name
    if (authStore.jsonMap.message_list && type != 'group') {
        name = authStore.jsonMap.message_list.private_name
    } else {
        name = authStore.jsonMap.message_list.name
    }
    Connector.send(
        name ?? 'get_chat_history',
        {
            message_type: authStore.jsonMap.message_list.message_type[type],
            group_id: id,
            user_id: id,
            message_seq: 0,
            message_id: 0,
            count: 1,
        },
        'getChatHistoryOnMsg_' + id,
    )
}

function getSessionTime(item: UserFriendElem & UserGroupElem) {
    const time = Number(item.time ?? 0)
    return Number.isFinite(time) ? time : 0
}

function getSessionSortName(item: UserFriendElem & UserGroupElem) {
    return item.py_start ?? getShowName(item.group_name ?? item.nickname ?? '', item.remark ?? '')
}

function getSessionList() {
    const contactStore = useContactStore()
    const settingsStore = useSettingsStore()
    const sessionMap = new Map<number, UserFriendElem & UserGroupElem>()

    if (settingsStore.sysConfig.session_display_mode === 'all') {
        contactStore.userList.forEach((item) => {
            const id = getSessionId(item)
            if (Number.isFinite(id) && id > 0) {
                sessionMap.set(id, item)
            }
        })
    }

    contactStore.baseOnMsgList.forEach((item, id) => {
        sessionMap.set(id, item)
    })

    return [...sessionMap.values()]
}

/**
 * 刷新消息列表排序
 */
export function updateBaseOnMsgList() {
    const contactStore = useContactStore()
    const settingsStore = useSettingsStore()
    const allList = getSessionList()
    // 先更具 item.always_top 是不是 true 拆为两个数组
    const topList = allList.filter((item) => item.always_top)
    const normalList = allList.filter((item) => !item.always_top)
    // 将两个数组按照 item.time 降序排序
    // item.time 不存在或者相同时按照 item.py_start 降序排序

    const sortFun = (
        a: UserFriendElem & UserGroupElem,
        b: UserFriendElem & UserGroupElem,
    ) => {
        const timeA = getSessionTime(a)
        const timeB = getSessionTime(b)
        if (timeA !== timeB) return timeB - timeA

        return getSessionSortName(b).localeCompare(getSessionSortName(a))
    }
    topList.sort(sortFun)
    normalList.sort(sortFun)

    let onMsgList = [] as any[]
    let groupAssistList = [] as any[]
    if (settingsStore.sysConfig.bubble_sort_user) {
        // 将 normalList 进行拆分
        const shouldShowInMainList = (item: UserFriendElem & UserGroupElem) => {
            return item.user_id || item.new_msg || item.highlight
        }
        onMsgList = topList.concat(normalList.filter((item) => {
            return shouldShowInMainList(item)
        }))
        groupAssistList = normalList.filter((item) => {
            return item.group_id && !shouldShowInMainList(item)
        })
    } else {
        onMsgList = topList.concat(normalList)
    }

    contactStore.onMsgList = onMsgList
    contactStore.groupAssistList = groupAssistList
}

/**
 * 判断当前消息是否可以通知
 * @param id 群号
 * @returns 是否可以通知
 */
export function canGroupNotice(id: number) {
    const authStore = useAuthStore()
    const noticeInfo = option.get('notice_group') ?? {}
    const list = noticeInfo[authStore.loginInfo.uin]
    if (list) {
        return list.indexOf(id) >= 0
    }
    return false
}

/**
 * 戳一戳触发动画
 * @param animeBody 动画作用的元素
 * @param windowInfo 窗口信息，在 electron 中使用
 */
export async function pokeAnime(animeBody: HTMLElement | null, windowInfo = null as {
    x: number
    y: number
    width: number
    height: number
} | null) {
    if (animeBody) {
        // animejs 只在这里用到，按需加载，避免它进主包拖慢首屏
        const { default: anime } = await import('animejs')
        const timeLine = anime.timeline({ targets: animeBody })
        // 如果窗口小于 500px 播放完整的动画（手机端样式）
        if (
            (document.getElementById('app')?.offsetWidth ?? 500) <
            500
        ) {
            navigator.vibrate([10, 740, 10])
            timeLine.add({ translateX: 30, duration: 600, easing: 'cubicBezier(.44,.09,.53,1)' })
                .add({ translateX: 0, duration: 150, easing: 'cubicBezier(.44,.09,.53,1)' })
                .add({ translateX: [0, 25, 0], duration: 500, easing: 'cubicBezier(.21,.27,.82,.67)' })
                .add({ targets: {}, duration: 1000 })
                .add({ translateX: 70, duration: 1300, easing: 'cubicBezier(.89,.72,.72,1.13)' })
                .add({ translateX: 0, duration: 100, easing: 'easeOutSine' })
        }
        timeLine.add({ translateX: [-10, 10, -5, 5, 0], duration: 500, easing: 'cubicBezier(.44,.09,.53,1)' })
        timeLine.change = async () => {
            if (animeBody) {
                animeBody.parentElement?.parentElement?.classList.add('poking')
                const teansformX = animeBody.style.transform
                // teansformX 的数字可能是科学计数法，需要转换为普通数字
                let num = Number((teansformX.match(/-?\d+\.?\d*/g) ?? [0])[0])
                // 取整
                num = Math.round(num)
                // 输出 translateX
                if (backend.isDesktop() && windowInfo) {
                    await backend.call(undefined, 'win:move', false, {
                        x: windowInfo.x + num,
                        y: windowInfo.y,
                    })
                }
            }
        }
        timeLine.changeComplete = () => {
            if (animeBody) {
                animeBody.parentElement?.parentElement?.classList.remove('poking')
            }
        }
    }
}

export function sendMsgAppendInfo(msg: any) {
    if (msg.message) {
        msg.message.forEach(() => {
            // TODO: 消息附加功能，暂时没用到
        })
    }
}

/**
 *
 * @param base group_name 或者 nickname
 * @param remark remark
 * @returns 显示的名称
 */
export function getShowName(base: string, remark: string) {
    if (!remark || remark == '' || remark == base) {
        return base.replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    } else {
        return (remark + '（' + base + '）').replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    }
}

/**
 * 判断是否需要显示时间戳（上下超过五分钟的消息）
 * @param timePrv 上条消息的时间戳（10 位）
 * @param timeNow 当前消息的时间戳（10 位）
 */
export function isShowTime(
    timePrv: number | undefined,
    timeNow: number,
    alwaysShow = false,
): boolean {
    if (alwaysShow) return true
    if (timePrv == undefined) return false
    // 五分钟 10 位时间戳相差 300
    return timeNow - timePrv >= 300
}

/**
 * 计算 QQ 等级图标
 * @param level QQ 等级
 * @returns 图标数量
 */
export function qqLevelIcons(level) {
    const result = {
        crown: 0,  // 皇冠
        sun: 0,    // 太阳
        moon: 0,   // 月亮
        star: 0    // 星星
    };

    result.crown = Math.floor(level / 64);
    level %= 64;

    result.sun = Math.floor(level / 16);
    level %= 16;

    result.moon = Math.floor(level / 4);
    level %= 4;

    result.star = level;

    return result;
}

/**
 * 计算 QQ 等级表情
 * @param level QQ 等级
 * @returns 表情字符串
 */
export function qqLevelToEmoji(level) {
    const rawLevel = level
    if (level <= 0) return level

    const crown = Math.floor(level / 64);
    level %= 64;

    const sun = Math.floor(level / 16);
    level %= 16;

    const moon = Math.floor(level / 4);
    level %= 4;

    const star = level;

    return '👑'.repeat(crown) + '☀️'.repeat(sun) + '🌙'.repeat(moon) + '⭐️'.repeat(star) + '（' + rawLevel + '）';
}

/**
 * 已量到的图片信息，按 URL 索引：原始尺寸（w / h）和长图角标的深浅（light）。
 *
 * 为什么需要它：消息里的 <img> 身上没有任何尺寸信息 —— OneBot 的图片段只有
 * file / url / file_size，没有宽高（段上真带着就顺手捡了，见
 * harvestImageSizesFromMsgs）；本地图片缓存（src/tauri/src/commands/db.rs 的
 * images 表）也只存字节。于是第一帧画出来的时候图片高度是 0，等解码完成才撑开，
 * 消息列表的总高度在画完之后还在长 —— 这是上拉翻历史时抖动的来源之一。
 *
 * 这里把量到的原始宽高在下一次渲染之前交出去，让 <img> 用 width / height 属性先
 * 把正确比例的框占住：浏览器按属性里的比例算尺寸，再套 max-width / max-height，
 * 于是解码前后布局一致，不会再长高。同一个 URL 量一次就够。
 *
 * 必须同步可读、且跨组件实例共享 —— 同一条消息会在消息列表和引用预览里各渲染一份，
 * 两份都得看到同一份数据。必须是响应式的，因为长图那对 class（.long-img / .light）
 * 也挂在它上面：class 交给模板算，才不会在下次重渲染时被 Vue 的 class 补丁抹掉
 * （以前是解码后 classList.add 上去的，模板一重渲染就没了）。
 */
interface ImageInfo {
    /** 原始宽高（自然尺寸，不是渲染后的尺寸）。 */
    w: number
    h: number
    /** 长图角标的深浅（.long-img.light）。取色是异步的，所以会比 w / h 晚到。 */
    light?: boolean
}

const imageInfos = ref<Record<string, ImageInfo>>({})

/** 取一张图片已量到的信息；还没量到就返回 undefined，由调用方决定要不要占位。 */
export function getImageInfo(url: string) {
    return imageInfos.value[url]
}

/**
 * 记录一张图片的原始尺寸（自然宽高，不是渲染后的尺寸）。同一个 URL 只记第一次，
 * 免得每次 load 都触发一轮重渲染。
 */
export function rememberImageSize(url: string, width: number, height: number) {
    if (!url || !Number.isFinite(width) || !Number.isFinite(height)) return
    if (width <= 0 || height <= 0) return
    if (imageInfos.value[url]) return
    imageInfos.value[url] = { w: width, h: height }
    scheduleImageInfoSave()
}

/**
 * 记录长图角标的深浅（.long-img.light）。取色是异步的、必然晚于尺寸到，所以单独一个
 * 入口。没有尺寸条目时（宽度为 0 的坏图）直接丢弃 —— 那张图本来也挂不上 .long-img。
 */
export function rememberImageTone(url: string, light: boolean) {
    const info = imageInfos.value[url]
    if (!info) return
    info.light = light
    scheduleImageInfoSave()
}

// ── 渲染前预加载 ──────────────────────────────────────────────────

/** 正在预加载的 URL → 它落定后的 Promise。同一张图被两批消息同时撞上时只加载一次。 */
const imagePreloads = new Map<string, Promise<void>>()

/**
 * 在图片渲染之前拿到它的原始宽高，写进 imageInfos。
 *
 * 为什么非要拿到图片本身：OneBot 的图片段只有 file / url / file_size，没有宽高（见上面
 * imageInfos 的注释），所以尺寸只能从图片本身读出来。
 *
 * 具体怎么读走 measureImageSize：有本地反代时只取开头一小段（HTTP Range）就够，拿不到
 * 才退回把整张图加载一遍。后者是唯一全平台通用的做法 —— fetch 字节要求先拿到字节，而
 * backend.proxy 只在 Tauri 上存在，web / electron 上 backend.proxyUrl 原样返回 CDN 地址，
 * 跨域 fetch 拿不到 CORS 头会被浏览器直接拒掉，一个字节都读不到；<img> 加载不受这条限制，
 * naturalWidth / naturalHeight 也不受 CORS 污染（只有 canvas 取像素才受限）。
 *
 * 退回整张加载时那次加载也不白做：响应进了浏览器的 HTTP 缓存，真正那个 <img> 挂上去时
 * 不会二次下载。所以 src 必须和 MsgBody.getImgSrc 用的是同一个 URL（都是 backend.proxyUrl），
 * 换了 URL 就命中不了缓存，等于白加载一遍。
 *
 * 绝不 reject —— 量不到就量不到，调用方照旧在没有占位框的情况下渲染，和改动前一样。
 * 404 / 403 / DNS / 断网都由 onerror 或 fetch 的失败分支覆盖。不设超时是明确的取舍：
 * 宁可多等，也不要在还能等到的时候提前把这一批消息放出去让它抖一下。
 */
export function preloadImageSize(url: string): Promise<void> {
    if (!url || !url.startsWith('http')) return Promise.resolve()
    if (getImageInfo(url)) return Promise.resolve()

    const inflight = imagePreloads.get(url)
    if (inflight) return inflight

    const task = measureImageSize(url)

    // 落定后清键。这里可以无条件删：在这条 promise 落定之前，任何重入的调用都会在
    // 上面撞到它并直接返回，所以此刻表里放着的必然还是它自己。
    const tracked = task.then(() => {
        imagePreloads.delete(url)
    })
    imagePreloads.set(url, tracked)
    return task
}

/**
 * 探尺寸时向上游要的字节数。
 *
 * 8KB 是量出来的，不是拍的：拿本地历史里 29 张真实 QQ 聊天图逐一试过，宽高最早 16 字节、
 * 最晚 890 字节就能解出来（GIF / PNG 在文件头里，JPEG 要走到 SOF 段，那张 890 的是带
 * 缩略图的 EXIF）—— 所以 8KB 对实测样本有 9 倍余量。
 *
 * 为什么不干脆多要一点：等待时间和「要多少字节」基本成正比。同一条连接上交替取同一张
 * 763KB 的图，中位数 1KB 191ms / 8KB 292ms / 64KB 782ms，更大的 64KB 之前还量到过 6.9s。
 * 这些字节只为读尺寸，一张都不进渲染（真正那张图由 <img> 自己下），能少要就少要。
 *
 * 万一遇到元数据更大的图（手机原图那种几十 KB 的 EXIF / ICC）这里就解不出来，退回整张
 * 加载 —— 慢，但结果正确，和没有这条快路径时一样。
 */
const IMAGE_SIZE_PROBE_BYTES = 8 * 1024

/**
 * 只取图片开头的一小段（HTTP Range）来读宽高，不把整张图下完。
 *
 * 为什么值得单独走一条路：真正贵的是「渲染前必须知道尺寸」这件事本身。实测一张 QQ 表情
 * 763KB、慢网上 14.5s，而宽高就在前 16 个字节里 —— 为了这十几个字节等 14.5s，整个会话就
 * 会卡在那儿不出现。改成只取开头一小段（同一张 0.2-0.8s），会话立刻能出来，剩下的整张图
 * 交给真正那个 <img> 在已经占好的框里慢慢流。
 *
 * 上游的 Range 是代理转发的（http_proxy.rs），所以这里只在有本地反代时走：web / electron
 * 上 backend.proxy 是空的，fetch 会直连 CDN，跨域拿不到 CORS 头就一个字节都读不到 ——
 * 那条路上还是只能靠 <img>（见 preloadImageSize 的说明）。
 *
 * 上游不支持 Range 就返回 200 带整张图，这里照样能从返回的字节里读出尺寸，不吃亏；认不出来
 * （截断在 SOF 之前、或根本不是图片）返回 null，调用方退回整张加载。
 */
async function probeImageSize(url: string): Promise<{ w: number, h: number } | null> {
    if (!backend.proxy) return null
    try {
        const resp = await fetch(backend.proxyUrl(url), {
            headers: { Range: `bytes=0-${IMAGE_SIZE_PROBE_BYTES - 1}` },
        })
        if (!resp.ok) return null
        return readImageSizeFromBytes(new Uint8Array(await resp.arrayBuffer()))
    } catch {
        return null
    }
}

/**
 * 量一张图的尺寸：先试只取开头一小段，探不到再退回把整张图加载一遍。
 *
 * 两条路都拿不到（404 / 断网 / 认不出的格式）就当没量到 —— 调用方照旧在没有占位框的
 * 情况下渲染，和改动前一样。
 */
async function measureImageSize(url: string): Promise<void> {
    const probed = await probeImageSize(url)
    if (probed) {
        rememberImageSize(url, probed.w, probed.h)
        return
    }

    // 量到 onload 为止，**不**再顺带 await img.decode()：解不解码都不影响占位框的正确性
    // （尺寸来自 naturalWidth / naturalHeight，onload 就有了），而 decode() 要把整张图解完
    // 才放行，这一批消息是 Promise.all 一起等的，等于让整页去等最慢那张图的解码。真正那个
    // <img> 挂上时解码就发生在它自己的框里 —— 框早就是最终尺寸，解多久都不动布局。
    await new Promise<void>((resolve) => {
        const img = new Image()
        img.onload = () => {
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                rememberImageSize(url, img.naturalWidth, img.naturalHeight)
            }
            resolve()
        }
        img.onerror = () => resolve()
        img.src = backend.proxyUrl(url)
    })
}

/** 单张图能占到的最大屏高：普通图被 MsgBody.imageWidthCss 折到 35vh，长图固定 40vh。 */
const MAX_IMAGE_SCREEN_RATIO = 0.4

/** 一行纯文本消息的估算高度（像素）。只用来决定等待窗口，不参与布局。 */
const TEXT_ROW_HEIGHT = 56

/**
 * 首屏等待窗口：从最新一条往回数到「够一屏」，返回需要等的条数。
 *
 * 为什么不必等整页（见 chatViewport 的注释）：列表是反转流，滚动原点钉在最新一条那一端，
 * 内容是贴着原点往远端长的。一行长高只推开它**远端**那一侧的内容，所以用户在底部时
 * （开房间、来新消息都是这个状态）视口**上方**那些行长高一个像素都推不动他看的东西。
 * 真正会动的只有视口**里面**那几行 —— 要等的就只是首屏这一截。
 *
 * 权重：一条消息里只要还有没量到尺寸的图，就按它能长到的最大高度计入；其余按一行文本
 * 计入。窗口因此会自己收敛 —— 图多的页面几步就凑满一屏（那正是等起来最贵的情况），图
 * 已经量过的页面则一路数回去，而后者本来就不用等：量到过的图 preloadImageSize 直接返回，
 * 把它们算进窗口不花钱。
 *
 * 为什么不用固定条数：一屏能放几条完全取决于那一页有多少图。图片行能占 40vh，一屏顶多
 * 两三张；文本行几十像素，一屏十几条。固定条数在图多的页面上等太多，在图少的页面上又
 * 等不够。
 *
 * 量不到视口时用窗口高度当近似。**不能退回整批**：这条路径是真实可走的 —— App.vue 里
 * Chat 页面挂在 `chatStore.chatInfo.show.id != 0` 上，点开本次启动的第一个会话时，
 * 「点会话」事件里跑到的这一趟（loadHistory → dbGetLatest）比 Chat 页面挂载还早，
 * `#msgPan` 那时还不存在。退回整批就等于「为了开一个会话，把整页几十张图全下载完」，
 * 而分页是 full 的时候这个「整批」还会随已加载条数一起涨 —— 这是打开会话最慢的一条路，
 * 恰恰又落在冷启动那次最显眼的打开上。
 *
 * 窗口高度比聊天面板略大（面板还要扣掉顶栏和输入区），所以这是个**偏大**的近似：宁可
 * 多等一两行，也不要少等 —— 少等就是那一行没量到尺寸、出生没有占位框，又抖回去。
 */
export function firstScreenMsgCount(msgs: any[]): number {
    const pan = document.getElementById('msgPan')
    let viewport = window.innerHeight
    if (pan != undefined && pan.clientHeight > 0) viewport = pan.clientHeight

    let covered = 0
    let count = 0
    for (let i = msgs.length - 1; i >= 0 && covered < viewport; i--) {
        const pending = extractImageUrlsFromMsgs([msgs[i]])
            .some(url => !getImageInfo(url))
        covered += pending ? viewport * MAX_IMAGE_SCREEN_RATIO : TEXT_ROW_HEIGHT
        count++
    }
    return count
}

/**
 * 等尺寸的上限（毫秒）：打开会话 / 整页替换。这一刻列表还没上屏，等的是首屏占位框，
 * 值得多等一会；但 Signal / Telegram 能「零等待」是因为宽高跟着消息元数据一起走，
 * OneBot 段里没有宽高、尺寸只能去网络上现量 —— 等待时长由网络决定，不设上限就等于
 * 让「会话什么时候打开」听命于最慢的那张图。
 */
export const PRELOAD_WAIT_CAP_OPEN_MS = 1500
/**
 * 等尺寸的上限（毫秒）：来新消息。消息到达的延迟是即时通讯里最显眼的卡顿，
 * 所以这里只给快速探测（本地反代的一次 Range 往返，实测中位在几百毫秒以内）留窗口；
 * 慢于上限就不等了 —— 消息立刻上屏、先顶预估框（MsgBody.preSize 的 estimate 分支），
 * 探测在后台继续，量到后框响应式地换成真实比例，纠正量被预估框压住、再由 chatViewport
 * 锚定兜住。
 */
export const PRELOAD_WAIT_CAP_LIVE_MS = 600

/**
 * 把一批消息里所有还没量到尺寸的远端图片先加载一遍。这一步必须跑在这些消息进列表
 * 之前 —— 测量晚一步，那一行出生就没有占位框，解码时才长高，而长在视口里的那一段
 * 没有任何补滚动的位置能救（见 MsgBody.preSize 的注释）。
 *
 * 整批图都会加载，但只**等**最新 waitCount 条消息里的那些（见 firstScreenMsgCount）。
 * 剩下的不等：它们在视口上方，等它们只是白白把这一批的渲染往后拖。
 *
 * **顺序就是这里的全部**（曾经不是，代价是打开会话要等好几秒）：串行发起这一批里的
 * 每一张图，浏览器按发起顺序排队，而所有预加载打进的是同一个源（Tauri 上都是本地反代
 * http://127.0.0.1:PORT，HTTP/1.1 同源 6 条连接）。所以**先发起的先下载**。以前这里
 * 是「整批一起点着、再等尾部的」——整批是按页序发起的，也就是从最旧那张开始，而视口里
 * 要等的正好是最新那几张：它们排在队列最末尾，前面几十张视口外的图不下载完，它们连
 * 请求都发不出去。等待窗口明明只有两三张图，等的时间却是「整页图片下载完」那么多。
 *
 * 现在分两拨：先发起并**等完**视口里那一撮（它们独占那 6 条连接），再发起其余的。
 * 视口外的图晚一个往返开始，但它们在视口上方、本来就不急着要；而打开会话的体感
 * 只由第一拨决定。
 *
 * waitCount 默认整批都等，也就是不传时的行为跟以前一致。
 *
 * waitCapMs 是等待的上限（默认无上限，保持老行为）。超时不是放弃：探测在后台继续，
 * 量到后 imageInfos 是响应式的，占位框自动换成真实比例 —— 超时的代价只是一次幅度
 * 被预估框压住的纠正，而不是「消息永远不来」。
 */
export async function preloadImageSizesForMsgs(
    msgs: any[],
    waitCount = msgs.length,
    waitCapMs = Number.POSITIVE_INFINITY,
): Promise<void> {
    // 用户开了手动加载就不该替他下载任何东西，占位块才是他的入口
    const settingsStore = useSettingsStore()
    if (settingsStore.sysConfig.opt_no_auto_load_image === true) return

    // 段上自带宽高的先捡出来，这些图下面就被过滤掉了，不用联网
    harvestImageSizesFromMsgs(msgs)

    const urls = [...new Set(extractImageUrlsFromMsgs(msgs))]
        .filter(url => !getImageInfo(url))
    if (urls.length === 0) return

    // 视口里的那些：列表尾部的 waitCount 条消息带的图
    const waiting = new Set(
        extractImageUrlsFromMsgs(msgs.slice(Math.max(0, msgs.length - waitCount))),
    )
    const first = urls.filter(url => waiting.has(url))
    const rest = urls.filter(url => !waiting.has(url))

    if (first.length === 0) {
        for (const url of rest) void preloadImageSize(url)
        return
    }

    // 第一拨：map 是同步跑完的，所以这一圈就把 img.src 按顺序全发出去，占住那 6 条连接。
    // 不加显式并发限制：浏览器自己会排队，再叠一层只会多一份状态。
    const firstDone = Promise.all(first.map(url => preloadImageSize(url)))

    // 第二拨：视口外的，等第一拨真正落定之后再点着（注意是 firstDone 而不是下面那个
    // 带上限的等待 —— 超时放行的是调用方，不是探测本身，这一拨照旧不占第一拨的连接）。
    void firstDone.then(() => {
        for (const url of rest) void preloadImageSize(url)
    })

    // 等第一拨，但只等到上限。超时后调用方拿预估框先把消息放上屏；探测继续跑，
    // 量到的那一下框再换成真实比例（响应式，见 MsgBody.preSize）。
    if (waitCapMs < Number.POSITIVE_INFINITY) {
        await Promise.race([
            firstDone,
            new Promise(resolve => setTimeout(resolve, waitCapMs)),
        ])
    } else {
        await firstDone
    }
}

/**
 * 遍历消息里所有可以预加载的远端图片段，逐个交给 visit。
 *
 * 转发消息的图片在 seg.content 里，要一起走：msgPreprocess 会在消息进列表之前就把
 * content 填好（msg.ts 的 forward 分支），所以转发里的图也在同一个时机处理得到。
 */
function walkRemoteImageSegments(msgs: any[], visit: (seg: any) => void): void {
    const walk = (segments: any) => {
        if (!Array.isArray(segments)) return
        for (const seg of segments) {
            if (!seg) continue
            if (seg.type === 'image' && typeof seg.url === 'string' && seg.url.startsWith('http')) {
                visit(seg)
            }
            if (Array.isArray(seg.content)) {
                for (const child of seg.content) walk(child?.message)
            }
        }
    }
    for (const msg of msgs) walk(msg?.message)
}

/**
 * 收集消息里所有可以预加载的远端图片 URL。
 */
export function extractImageUrlsFromMsgs(msgs: any[]): string[] {
    const urls: string[] = []
    walkRemoteImageSegments(msgs, seg => urls.push(seg.url))
    return urls
}

/**
 * 从图片段自身带的宽高字段里捡尺寸，免得为一张已经写明尺寸的图再跑一趟网络。
 *
 * 目前没有任何已知的连接器会填这两个字段：OneBot 标准里图片段只有 file / url /
 * file_size，NapCat / Lagrange 的适配层也没往外带。但底层是有这个数据的 ——
 * NTQQ 自己发图时就带着宽高，Lagrange.Core 的 ImageEntity 有 ImageSize 字段
 * （ImageSize = new Vector2(info.Width, info.Height)），是适配层在段边界上把它丢了。
 * 所以这里是零成本快路径，不是当前必须走的路：真有连接器开始往外带（或者本项目的
 * 后端以后开始透传），捡到就直接 rememberImageSize，下面那圈 !getImageInfo 的过滤
 * 会跳过这些图，一整个网络的往返就省下来了。字段名取 width / height 和 w / h 两种 ——
 * 两边都不成文，多认一种不花钱。
 */
export function harvestImageSizesFromMsgs(msgs: any[]): void {
    walkRemoteImageSegments(msgs, seg => {
        rememberImageSize(seg.url, Number(seg.width ?? seg.w), Number(seg.height ?? seg.h))
    })
}

/**
 * 尺寸表的落盘。存在独立的 localStorage 键里，**不**挂进设置项（optDefault）：
 * Option.saveAll 每次保存都会把所有设置项重新序列化 + encodeURIComponent 写进
 * localStorage['options']，桌面端还会用 store.store = arg 整个替换 electron-store /
 * Tauri 存储（src/electron/function/ipc.ts）。几百条 URL 挂进去，等于用户每改一次设置
 * 就重编码一遍整张表。独立键完全绕开那条路径，opt:saveAll 也碰不到它。
 *
 * 为什么必须落盘：这张表原先只在内存里，重启即失 —— 客户端明明已经量到过每一张图的
 * 比例，却每次启动都从头再学一遍，于是每张图在每个会话里都要先撑开一次。这是「尺寸
 * 信息在源头被丢掉」在本项目里最实的一处（协议不给宽高，客户端自己也不留）。
 */
const IMAGE_INFO_STORAGE_KEY = 'image_infos'
const IMAGE_INFO_STORAGE_VERSION = 1
/** 落盘条目上限，超出按插入顺序淘汰最旧的（JS 对象字符串键保持插入顺序）。 */
const IMAGE_INFO_LIMIT = 2000
/** 超过这个长度的键不落盘：那是内联的 data / base64 地址，又长又只在本会话有意义。 */
const IMAGE_INFO_KEY_LIMIT = 2048
/** 写入去抖：一屏图陆续解码完可能连着记十几条，没必要每条都序列化一次整张表。 */
const IMAGE_INFO_WRITE_DELAY = 2000

function getImageInfoStorage(): Storage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage
    } catch {
        // 某些环境下光是访问 localStorage 就会抛
        return null
    }
}

/** 这个键值不值得落盘。内联地址记在内存里就够了 —— 它换个会话就是另一个字符串。 */
function isPersistableImageKey(url: string) {
    return url.length <= IMAGE_INFO_KEY_LIMIT &&
        !url.startsWith('data:') && !url.startsWith('base64://')
}

function buildImageInfoPayload(urls: string[]) {
    const map: Record<string, number[]> = {}
    for (const url of urls) {
        const info = imageInfos.value[url]
        if (!info) continue
        map[url] = info.light ? [info.w, info.h, 1] : [info.w, info.h]
    }
    return JSON.stringify({ v: IMAGE_INFO_STORAGE_VERSION, m: map })
}

let imageInfoSaveTimer: ReturnType<typeof setTimeout> | undefined
let imageInfoFlushHooked = false

/** 退出前把待写的表刷掉，免得落在最后一个去抖窗口里的条目丢掉。 */
function hookImageInfoFlush() {
    if (imageInfoFlushHooked || typeof window === 'undefined') return
    imageInfoFlushHooked = true
    window.addEventListener('pagehide', flushImageInfoSave)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushImageInfoSave()
    })
}

function saveImageInfos() {
    const storage = getImageInfoStorage()
    if (!storage) return
    const keys = Object.keys(imageInfos.value).filter(isPersistableImageKey)
    if (keys.length === 0) return
    const kept = keys.length > IMAGE_INFO_LIMIT ? keys.slice(-IMAGE_INFO_LIMIT) : keys
    try {
        storage.setItem(IMAGE_INFO_STORAGE_KEY, buildImageInfoPayload(kept))
    } catch {
        // 配额满了：砍掉一半再试一次。再失败就放弃 —— 尺寸只是占位优化的输入，
        // 丢了顶多重新学一遍，不该因为存缓存失败而影响别的功能。
        try {
            storage.setItem(
                IMAGE_INFO_STORAGE_KEY,
                buildImageInfoPayload(kept.slice(Math.floor(kept.length / 2))),
            )
        } catch {
            // 放弃这次落盘
        }
    }
}

function flushImageInfoSave() {
    if (imageInfoSaveTimer === undefined) return
    clearTimeout(imageInfoSaveTimer)
    imageInfoSaveTimer = undefined
    saveImageInfos()
}

function scheduleImageInfoSave() {
    if (!getImageInfoStorage()) return
    hookImageInfoFlush()
    if (imageInfoSaveTimer !== undefined) clearTimeout(imageInfoSaveTimer)
    imageInfoSaveTimer = setTimeout(() => {
        imageInfoSaveTimer = undefined
        saveImageInfos()
    }, IMAGE_INFO_WRITE_DELAY)
}

/**
 * 读回上一次会话量到的尺寸。
 *
 * 在模块加载时就读，而不是等某个组件的 onMounted：Vue 的子组件 mounted 早于父组件，
 * 放在 App.vue 的 onMounted 里并不保证早于 Chat.vue 的第一帧，而这里必须早于第一张图
 * 的渲染 —— 读晚一步，那一屏图就会照旧在没有比例的情况下出生，这次修改也就白做了。
 */
function hydrateImageSizes() {
    const storage = getImageInfoStorage()
    if (!storage) return
    let raw: string | null = null
    try {
        raw = storage.getItem(IMAGE_INFO_STORAGE_KEY)
    } catch {
        return
    }
    if (!raw) return

    const loaded: Record<string, ImageInfo> = {}
    try {
        const parsed = JSON.parse(raw)
        if (!parsed || parsed.v !== IMAGE_INFO_STORAGE_VERSION) return
        const map = parsed.m
        if (!map || typeof map !== 'object') return
        for (const url of Object.keys(map)) {
            const entry = map[url]
            if (!Array.isArray(entry)) continue
            const [w, h, light] = entry
            if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue
            loaded[url] = light ? { w, h, light: true } : { w, h }
        }
    } catch {
        // 表被改坏 / 解析失败：当空表重新学一遍，绝不能连累启动
        return
    }
    // 本会话已经量到的优先，别让盘上的旧值盖掉刚量到的
    imageInfos.value = { ...loaded, ...imageInfos.value }
}

hydrateImageSizes()

/**
 * 从图片字节的前缀里读出原始宽高（PNG / JPEG / GIF / WebP / BMP）。
 *
 * 为什么要有它：本地历史（src/tauri/src/commands/db.rs 的 images 表）里存的是字节，
 * 消息段里又没有宽高，所以从 DB 翻出来的那一页消息在出生的时候一张图都不认识 ——
 * preSize 交不出占位盒，每张图都得等解码完才撑开，而这一页往往正好在视口里（上拉
 * 翻历史就是这么翻的），撑开量不可能靠滚动补回来。把字节开头解出来扫一眼文件头，
 * 就能在这一页挂载之前把尺寸写进 imageInfos，让这些行出生就带着正确的 aspect-ratio
 * （见 localHistoryUtil.prewarmImageSizes）。
 *
 * 只解码前缀（64KB，够过掉 EXIF 之类的元数据）、只读文件头，不做完整解码。认不出来
 * 就返回 null，退回老行为：解码时撑开、由 imageLoaded 去补。
 */
export function readImageSizeFromBase64(base64: string): { w: number, h: number } | null {
    if (!base64) return null
    let bytes: Uint8Array
    try {
        bytes = base64PrefixToBytes(base64, 64 * 1024)
    } catch {
        return null
    }
    return readImageSizeFromBytes(bytes)
}

/**
 * readImageSizeFromBase64 的字节版。
 *
 * 认不出来就返回 null —— 注意「认不出来」包含「这一小段里没有尺寸」：JPEG 的尺寸在 SOF 段里，
 * 而 SOF 可能被 EXIF 挤到很后面（readJpegSize 的段链走不到头就返回 null，它只按手里的字节
 * 走，不会越界读，所以截断只会让结果变 null、不会给出一个错尺寸）。调用方遇到 null 要退回
 * 「把整张图拿全再量」，不能拿它当 0×0 记下来。
 */
export function readImageSizeFromBytes(bytes: Uint8Array): { w: number, h: number } | null {
    if (bytes.length < 16) return null

    const size =
        readPngSize(bytes) ??
        readGifSize(bytes) ??
        readBmpSize(bytes) ??
        readWebpSize(bytes) ??
        readJpegSize(bytes)
    if (!size || !Number.isFinite(size.w) || !Number.isFinite(size.h)) return null
    if (size.w <= 0 || size.h <= 0) return null
    return size
}

/**
 * 从字节签名里读出真实的 MIME 类型（PNG / JPEG / GIF / WebP / BMP），认不出来返回 null。
 *
 * 为什么要从字节认、而不是信响应头：上游和代理都会说谎。而这个类型会被当成 data: URL 的
 * 类型存进本地图片缓存 —— data: URL 不做内容嗅探，声明成什么就按什么解析，一旦存错，这张
 * 图在缓存里就永久打不开了（不是「显示得奇怪」，是不显示），除非清缓存。字节本来就在手上，
 * 看一眼签名就能把类型钉死，本地库里的真相不该由上游的一个头部决定。
 */
export function readImageMimeFromBytes(bytes: Uint8Array): string | null {
    if (bytes.length < 12) return null
    if (bytes[0] === 0x89 && tag(bytes, 1, 'PNG')) return 'image/png'
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'image/jpeg'
    if (tag(bytes, 0, 'GIF')) return 'image/gif'
    if (tag(bytes, 0, 'RIFF') && tag(bytes, 8, 'WEBP')) return 'image/webp'
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) return 'image/bmp'
    return null
}

/** readImageMimeFromBytes 的 base64 入口：只解前缀，不解整张图。 */
export function readImageMimeFromBase64(base64: string): string | null {
    if (!base64) return null
    try {
        return readImageMimeFromBytes(base64PrefixToBytes(base64, 64))
    } catch {
        return null
    }
}

/** 解码 base64 开头的一小段（最多 byteLimit 字节）。data: 前缀会被剥掉。 */
function base64PrefixToBytes(base64: string, byteLimit: number): Uint8Array {
    let body = base64
    const comma = body.indexOf(',')
    if (body.startsWith('data:') && comma >= 0) body = body.slice(comma + 1)

    const charsNeeded = Math.ceil(byteLimit / 3) * 4
    let chunk = body.length > charsNeeded ? body.slice(0, charsNeeded) : body
    // atob 要求长度是 4 的倍数，且不接受换行
    chunk = chunk.replace(/[\s]/g, '')
    const rem = chunk.length % 4
    if (rem !== 0) chunk = chunk.slice(0, chunk.length - rem)

    const binary = atob(chunk)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
}

function u16be(b: Uint8Array, i: number) {
    return (b[i] << 8) | b[i + 1]
}
function u16le(b: Uint8Array, i: number) {
    return b[i] | (b[i + 1] << 8)
}
function u32be(b: Uint8Array, i: number) {
    return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
}
function u32le(b: Uint8Array, i: number) {
    return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
}
function u24le(b: Uint8Array, i: number) {
    return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
}
function tag(b: Uint8Array, i: number, text: string) {
    for (let k = 0; k < text.length; k++) {
        if (b[i + k] !== text.charCodeAt(k)) return false
    }
    return true
}

/** PNG：IHDR 里的宽度 / 高度都是大端 32 位。 */
function readPngSize(b: Uint8Array) {
    if (b.length < 24) return null
    if (b[0] !== 0x89 || !tag(b, 1, 'PNG')) return null
    if (!tag(b, 12, 'IHDR')) return null
    return { w: u32be(b, 16), h: u32be(b, 20) }
}

/** GIF：宽高是小端 16 位，紧跟在 6 字节的签名版本之后。 */
function readGifSize(b: Uint8Array) {
    if (b.length < 10 || !tag(b, 0, 'GIF')) return null
    return { w: u16le(b, 6), h: u16le(b, 8) }
}

/** BMP：宽高是小端 32 位（高度为负表示自上而下，取绝对值）。 */
function readBmpSize(b: Uint8Array) {
    if (b.length < 26) return null
    if (b[0] !== 0x42 || b[1] !== 0x4D) return null

    // 头长度决定宽高字段的宽度：OS/2 的 BITMAPCOREHEADER 是 12 字节、宽高各 16 位，
    // 其余（BITMAPINFOHEADER 40 / V4 108 / V5 124 / OS/2 2.x 的 64）宽高都在 18、22
    // 这两个位置、各 32 位。按 32 位去读 12 字节的头会读出一对垃圾数字（实测：300x200
    // 读成 13107500x1572865），而垃圾尺寸会被当成真尺寸记住、还会被钉进 aspect-ratio，
    // 比不认它更糟 —— 头长度小到连这两个位置都对不上的，就别给。
    const headerSize = u32le(b, 14)
    if (headerSize === 12) return { w: u16le(b, 18), h: u16le(b, 20) }
    if (headerSize < 16) return null

    const w = u32le(b, 18)
    const h = u32le(b, 22)
    return { w, h: h > 0x7FFFFFFF ? 0x100000000 - h : h }
}

/** WebP：RIFF 容器，三种子格式的尺寸字段位置各不相同。 */
function readWebpSize(b: Uint8Array) {
    if (b.length < 32) return null
    if (!tag(b, 0, 'RIFF') || !tag(b, 8, 'WEBP')) return null

    if (tag(b, 12, 'VP8 ')) {
        // 有损：关键帧起始码 9D 01 2A 之后的 14 位宽 + 14 位高
        if (b[23] !== 0x9D || b[24] !== 0x01 || b[25] !== 0x2A) return null
        return { w: u16le(b, 26) & 0x3FFF, h: u16le(b, 28) & 0x3FFF }
    }
    if (tag(b, 12, 'VP8L')) {
        // 无损：签名 0x2F 之后 32 位里塞了 14 位宽 + 14 位高（都存的是减一）
        if (b[20] !== 0x2F) return null
        const bits = u32le(b, 21)
        return { w: (bits & 0x3FFF) + 1, h: ((bits >> 14) & 0x3FFF) + 1 }
    }
    if (tag(b, 12, 'VP8X')) {
        // 扩展：24 位宽 + 24 位高（减一）
        return { w: u24le(b, 24) + 1, h: u24le(b, 27) + 1 }
    }
    return null
}

/**
 * JPEG 的 EXIF 里读方向标记（Orientation，IFD0 的 tag 0x0112）。
 *
 * 为什么需要：浏览器渲染 JPEG 时默认按这个标记把图转正（image-orientation: from-image），
 * 所以「原始字节 400x600 + Orientation 6」在引擎里量出来的自然尺寸是 600x400（实测
 * WebKitGTK 4.1 的 naturalWidth/naturalHeight 就是转正后的）。照原始字节读出来的是没转正的
 * 宽高，拿它占位等于把横图塞进竖框 —— 图片会被压扁，而且这个错尺寸会被钉进 aspect-ratio
 * 一路错下去。手机拍的照片几乎都带这个标记，所以不能不管。
 */
function readExifOrientation(b: Uint8Array, start: number, size: number): number | null {
    if (size < 14) return null
    const end = Math.min(b.length, start + size)
    let p = start
    if (!tag(b, p, 'Exif') || b[p + 4] !== 0 || b[p + 5] !== 0) return null
    p += 6

    let le: boolean
    if (b[p] === 0x49 && b[p + 1] === 0x49) le = true       // 'II'
    else if (b[p] === 0x4D && b[p + 1] === 0x4D) le = false // 'MM'
    else return null

    const rd16 = (i: number) => (le ? u16le(b, i) : u16be(b, i))
    const rd32 = (i: number) => (le ? u32le(b, i) : u32be(b, i))

    if (rd16(p + 2) !== 42) return null
    const ifd0 = p + rd32(p + 4)
    if (ifd0 + 2 > end) return null

    const count = rd16(ifd0)
    for (let k = 0; k < count; k++) {
        const entry = ifd0 + 2 + k * 12
        if (entry + 12 > end) return null
        if (rd16(entry) === 0x0112) {
            const value = rd16(entry + 8)
            return value >= 1 && value <= 8 ? value : null
        }
    }
    return null
}

/** JPEG：要顺着段链找 SOF，所以放在最后 —— 前面几个看一眼签名就否掉了。 */
function readJpegSize(b: Uint8Array) {
    if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null

    let i = 2
    let orientation = 0
    while (i + 9 < b.length) {
        if (b[i] !== 0xFF) { i++; continue }
        const marker = b[i + 1]
        if (marker === 0xFF) { i++; continue }        // 填充字节
        if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) {
            i += 2                                     // 无长度字段的独立标记
            continue
        }
        const len = u16be(b, i + 2)
        if (len < 2) return null
        const isSof =
            marker >= 0xC0 && marker <= 0xCF &&
            marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC
        if (isSof) {
            const w = u16be(b, i + 7)
            const h = u16be(b, i + 5)
            // Orientation 5~8 是转过 90° 的，引擎会把它俩对调着渲染
            return orientation >= 5 ? { w: h, h: w } : { w, h }
        }
        if (marker === 0xE1 && orientation === 0) {
            const o = readExifOrientation(b, i + 4, len - 2)
            if (o) orientation = o
        }
        i += 2 + len
    }
    return null
}

/**
 * 将图片 URL 转换为 PNG 格式的 Uint8Array
 * 支持 base64 和 HTTP URL 格式的图片
 * @param imageUrl 图片 URL
 */
export async function getImageUrlData(imageUrl: string): Promise<{ buffer: Uint8Array, blob: Blob }> {
    return new Promise((resolve, reject) => {
        const img = new Image()

        img.onload = () => {
            try {
                // 创建 canvas 并设置尺寸
                const canvas = document.createElement('canvas')
                canvas.width = img.width
                canvas.height = img.height

                // 获取 2D 上下文并绘制图片
                const ctx = canvas.getContext('2d')
                if (!ctx) {
                    reject(new Error('无法获取 Canvas 上下文'))
                    return
                }

                ctx.drawImage(img, 0, 0)

                // 将 canvas 转换为 PNG 格式的 blob
                canvas.toBlob((blob) => {
                    if (!blob) {
                        reject(new Error('图片转换失败'))
                        return
                    }

                    // 读取 blob 为 ArrayBuffer，然后转换为 Uint8Array
                    const reader = new FileReader()
                    reader.onload = () => {
                        const arrayBuffer = reader.result as ArrayBuffer
                        resolve({
                            buffer: new Uint8Array(arrayBuffer),
                            blob: blob
                        }
                        )
                    }
                    reader.onerror = () => {
                        reject(new Error('读取图片数据失败'))
                    }
                    reader.readAsArrayBuffer(blob)
                }, 'image/png') // 强制转换为 PNG 格式
            } catch (error) {
                reject(error)
            }
        }

        img.onerror = () => {
            reject(new Error('图片加载失败'))
        }

        // 处理跨域问题
        img.crossOrigin = 'anonymous'
        img.src = imageUrl
    })
}

/**
 * 判断这个消息是不是[已删除]
 * @param msg
 */
export function isDeleteMsg(msg: any): boolean {
    const authStore = useAuthStore()
    if (!['message', 'message_sent'].includes(msg.post_type)) return false
    if (msg.sender.user_id !== authStore.loginInfo.uin) return false
    if (msg.raw_message !== '&#91;已删除&#93;') return false
    return true
}

/**
 * 获取两个字符串之间的差异
 * @param a 原字符串
 * @param b 新字符串
 * @returns 差异列表，包含差异的起始位置、结束位置和差异内容
 */
export function getDifferencesWithRanges(a: string, b: string) {
    let i = 0; // a 的指针
    let j = 0; // b 的指针
    const diffs = [] as { start: number; end: number; str: string }[]
    let currentDiffStart = null as number | null
    let currentDiffStr = ''

    while (j < b.length) {
        if (i < a.length && a[i] === b[j]) {
            // 遇到匹配字符，先保存上一个差异块
            if (currentDiffStr) {
                diffs.push({
                    start: currentDiffStart!,
                    end: j - 1,
                    str: currentDiffStr
                })
                currentDiffStr = ''
                currentDiffStart = null
            }
            i++;
        } else {
            // 遇到差异字符，记录
            if (currentDiffStart === null) currentDiffStart = j;
            currentDiffStr += b[j];
        }
        j++;
    }

    // 遍历结束，如果还有未保存的差异块
    if (currentDiffStr) {
        diffs.push({
            start: currentDiffStart!,
            end: j - 1,
            str: currentDiffStr
        });
    }

    return diffs;
}

/**
 * lgr专用发送消息，懒得写了，不做通用适配，胡乱应付下吧
 * @param msg 消息内容
 */
function lgrSendMsg(id: string, msg: any, type: string, cb: string) {
    if (msg[0].type === 'node') {
        const sendMsgs = [] as any[]
        msg.forEach((item) => {
            const msg = {
                type: item.type,
                data: {
                    user_id: item.data.user_id.toString(),
                    nickname: item.data.nickname,
                    content: item.data.content.map((item) => {
                        const copy = { ...item }
                        delete copy.type
                        return {
                            type: item.type,
                            data: { ...copy }
                        }
                    }),
                },
            }
            sendMsgs.push(msg)
        })
        if (type === 'group') {
            Connector.send(
                'send_group_forward_msg',
                { group_id: id, messages: sendMsgs },
                cb,
            )
        } else if (type === 'user') {
            Connector.send(
                'send_private_forward_msg',
                { user_id: id, messages: sendMsgs },
                cb,
            )
        } else {
            new PopInfo().add(PopType.ERR, 'lgr不支持匿名聊天')
        }
    } else {
        if (type === 'group') {
            Connector.send(
                'send_group_msg',
                { group_id: id, message: msg },
                cb,
            )
        } else if (type === 'user') {
            Connector.send(
                'send_private_msg',
                { user_id: id, message: msg },
                cb,
            )
        } else {
            new PopInfo().add(PopType.ERR, 'lgr不支持匿名聊天')
        }
    }
}
