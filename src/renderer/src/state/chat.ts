import { ChatInfoElem, MergeStackData } from '@renderer/function/elements/information'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useChatStore = defineStore('chat', () => {
    const chatInfo = ref<ChatInfoElem>({
        show: { type: '', id: 0, name: '', avatar: '' },
        info: {
            group_info: {},
            user_info: {},
            me_info: {},
            group_members: [],
            group_files: {},
            group_sub_files: {},
            jin_info: {
                list: [],
                pages: 0,
            },
        },
    })

    const messageList = ref<any[]>([])
    // 回复预览补拉缓存：message_id -> 消息（null 表示确认拿不到，别再反复请求）。
    // 回复段本身只带一个目标 id（见 appUtil 的 parseMsg），正文不在手上，所以目标
    // 没被加载进来时预览就没得渲染，只能按需补拉。单开一份而不是直接塞进
    // messageList：那是分页窗口，一屏几十条回复行各塞一条会把窗口搅乱 —— 只有用户
    // 点引用要跳过去时，才把这一条提升进列表（见 msg.ts 的 promoteReplyTarget）。
    const replyPreviewMap = ref<Map<string, any>>(new Map())
    const mergeMsgStack = ref<MergeStackData[]>([])
    const mergeMessageList = ref<any[] | undefined>(undefined)
    const mergeMessageImgList = ref<any[] | undefined>(undefined)

    return {
        chatInfo,
        messageList,
        replyPreviewMap,
        mergeMsgStack,
        mergeMessageList,
        mergeMessageImgList,
    }
})
