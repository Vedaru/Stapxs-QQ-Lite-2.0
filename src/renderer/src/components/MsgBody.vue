<!--
 * @FileDescription: 消息模板
 * @Author: Stapxs
 * @Date:
 *      2022/08/03
 *      2022/12/12
 * @Version:
 *      1.0 - 初始版本
 *      1.5 - 重构为 ts 版本，代码格式优化
-->

<template>
    <!-- type === 'body' 是「被引用的消息副本」（回复引用、原始消息预览），同一条
         消息会在聊天列表里再渲染一次。两处都挂 chat-* id 的话，scrollToMsg 用
         getElementById 取到的是 DOM 里靠前的那个副本，滚动位置就跳到了引用块
         里。只给列表里那一份发 id。 -->
    <div :id="type === 'body' ? undefined : 'chat-' + data.message_id"
        ref="msgMain"
        v-menu.prevent="event => $emit('showMenu', event, data)"
        :class="[
            'message', type ?? '',
            { 'revoke': data.revoke },
            { 'me': isMe && type != 'body' },
            { 'selected': selected },
            { 'right': settingsStore.sysConfig.opt_ind_message === true && type != 'body' },
            { 'body-only': type == 'body' }
        ]"
        :data-raw="getMsgRawTxt(data)"
        :data-sender="data.sender.user_id"
        :data-time="data.time"
        @mouseleave="hiddenUserInfo">
        <template v-if="type != 'body'">
            <img v-menu.prevent="event => $emit('showMenu', event, data)"
                v-user-tooltip="() => getUserById(data.sender.user_id)"
                name="avatar"
                :src="'https://q1.qlogo.cn/g?b=qq&s=0&nk=' + data.sender.user_id"
                :alt="data.sender.card ? data.sender.card : data.sender.nickname"
                @dblclick="sendPoke">
            <div v-if="data.fake_msg == true"
                :class="'sending left' + (isMe ? ' me' : '')">
                <font-awesome-icon :icon="['fas', 'spinner']" />
            </div>
        </template>
        <div :class="msgBodyClass">
            <header v-if="type != 'body'">
                <template v-if="chatStore.chatInfo.show.type == 'group'">
                    <span v-if="senderInfo && isRobot(senderInfo.user_id)" class="robot">{{ $t('机器人') }}</span>
                    <span v-if="senderInfo?.role == 'owner'" class="owner">{{ $t('群主') }}</span>
                    <span v-else-if="senderInfo?.role == 'admin'" class="admin">{{ $t('管理员') }}</span>
                    <span v-if="senderInfo?.title && senderInfo?.title != ''">{{ senderInfo?.title.replace(/[\u202A-\u202E\u2066-\u2069]/g, '') }}</span>
                </template>
                <span v-if="isDev && data._from_local_db" class="dev-local-tag">
                    {{ $t('本地') }}
                </span>
                <a v-if="data.sender.card || data.sender.nickname">
                    {{ data.sender.card ? data.sender.card : data.sender.nickname }}
                </a>
                <a v-else>
                    {{ isMe ? authStore.loginInfo.nickname : chatStore.chatInfo.show.name }}
                </a>
                <a v-if="selected" class="time">
                    {{ Intl.DateTimeFormat(trueLang, {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: 'numeric',
                        minute: 'numeric',
                        second: 'numeric',
                    }).format(getViewTime(getViewTime(data.time))) }}
                </a>
            </header>
            <div v-move="moveOptions"
                @v-move-left.prevent="$emit('leftMove', data)"
                @v-move-right.prevent="$emit('rightMove', data)">
                <!-- 消息体 -->
                <template v-if="data.message.length === 0">
                    <span class="msg-text" style="opacity: 0.5">{{ $t('空消息') }}</span>
                </template>
                <!-- 超级表情 -->
                <template v-else-if="isSuperFaceMsg()">
                    <div class="msg-img face lottie-face alone">
                        <LazyLottie
                            :animation-link="Emoji.get(Number(data.message[0].id))!.superValue!"
                            :title="Emoji.get(Number(data.message[0].id))!.description" />
                    </div>
                </template>
                <template v-else-if="!hasCard()">
                    <div v-for="(item, index) in data.message"
                        :key="data.message_id + '-m-' + index"
                        :class="{ 'msg-inline': View.isMsgInline(item.type) }">
                        <div v-if="item.type === undefined" />
                        <span v-else-if="isDebugMsg" class="msg-text">{{ item }}</span>
                        <template v-else-if="item.type == 'text'">
                            <div v-if="hasMarkdown()" class="msg-md-title" />
                            <span v-else v-show="item.text !== ''"
                                class="msg-text" @click="textClick" v-html="textIndex[index]" />
                        </template>
                        <div v-else-if="item.type == 'markdown'" v-once
                            :id="getMdHTML(item.content, 'msg-md-' + data.message_id)"
                            class="msg-md" />
                        <img v-else-if="item.type == 'image' && item.file == 'marketface'"
                            :class=" imgStyle(data.message.length, Number(index), true) + ' msg-mface' + preImgClass(item.url)"
                            :src="item.url"
                            :alt="item.summary"
                            :data-img-url="item.url"
                            v-bind="preSize(item.url)"
                            @load="imageLoaded"
                            @error="imgLoadFail">
                        <img v-else-if="item.type == 'mface'"
                            :class=" imgStyle(data.message.length, Number(index), true) + ' msg-mface' + preImgClass(item.url)"
                            :src="item.url"
                            :alt="item.summary"
                            :data-img-url="item.url"
                            v-bind="preSize(item.url)"
                            @load="imageLoaded"
                            @error="imgLoadFail">
                        <template v-else-if="item.type == 'image'">
                            <div v-show="shouldShowImagePlaceholder(item, Number(index))"
                                :title="$t('点击加载图片')"
                                :class="imgStyle(data.message.length, Number(index), isFace(item)) + ' msg-img-placeholder'"
                                @click="loadImage(item, Number(index))">
                                <font-awesome-icon
                                    :icon="['fas', imageLoading(getImageKey(Number(index), item.url)) ? 'spinner' : 'image']"
                                    :spin="imageLoading(getImageKey(Number(index), item.url))" />
                                <span>
                                    {{ imageLoading(getImageKey(Number(index), item.url)) ? $t('加载中') : $t('点击加载图片') }}
                                </span>
                            </div>
                            <img v-show="!shouldShowImagePlaceholder(item, Number(index))"
                                :title="(!item.summary || item.summary == '') ? $t('预览图片') : item.summary"
                                :alt="$t('图片')"
                                :class=" imgStyle(data.message.length, Number(index), isFace(item)) + preImgClass(item.url)"
                                :src="getImgSrc(item.url)"
                                data-type="image"
                                :data-img-url="item.url"
                                v-bind="preSize(item.url, true)"
                                @load="imageLoaded"
                                @error="imgLoadFail"
                                @click="imgClick(item.url)">
                        </template>
                        <template v-else-if="item.type == 'face'">
                            <EmojiFace :emoji="Emoji.get(Number(item.id))" class="msg-face" />
                        </template>
                        <span v-else-if="item.type == 'bface'"
                            style="font-style: italic; opacity: 0.7">
                            [ {{ $t('图片') }}：{{ item.text }} ]
                        </span>
                        <div v-else-if="item.type == 'at'"
                            :class="getAtClass(item.qq)">
                            <a v-user-tooltip="() => getAtMember(item.qq)"
                                :data-id="item.qq"
                                :data-group="data.group_id">
                                {{ getAtName(item) }}
                            </a>
                        </div>
                        <div
                            v-else-if="item.type == 'file'" :class="'msg-file' + (isMe ? ' me' : '')">
                            <div>
                                <div>
                                    <a>
                                        <font-awesome-icon :icon="['fas', 'file']" />
                                        {{ chatStore.chatInfo.show.type == 'group' ? $t('群文件') : $t('离线文件') }}
                                    </a>
                                    <p>{{ loadFileBase( item, item.name ?? item.file_name, data.message_id) }}</p>
                                </div>
                                <i>{{ getSizeFromBytes(item.size ?? item.file_size) }}</i>
                            </div>
                            <div>
                                <font-awesome-icon
                                    :icon="['fas', 'angle-down']"
                                    @click="downloadFile(item, data.message_id)" />
                            </div>
                            <div v-if="data.fileView && Object.keys(data.fileView).length > 0"
                                class="file-view">
                                <img v-if="['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(data.fileView.ext)"
                                    :src="data.fileView.url">
                                <video v-else-if="['mp4', 'avi', 'mkv', 'flv'].includes(data.fileView.ext)"
                                    playsinline controls muted
                                    autoplay>
                                    <source :src="data.fileView.url"
                                        :type="'video/' + data.fileView.ext">
                                    现在还有不支持 video tag 的浏览器吗？
                                </video>
                                <span v-else-if="['txt', 'md'].includes(data.fileView.ext) && (item.size ?? item.file_size) < 2000000" class="txt">
                                    <a>&gt; {{ item.name }} - {{ $t('文件预览') }}</a>
                                    {{ getTxtUrl(data.fileView) }}{{ data.fileView.txt }}
                                </span>
                            </div>
                        </div>
                        <div v-else-if="item.type == 'video' && getVideoSrc(item)"
                            class="msg-video">
                            <video playsinline controls muted
                                autoplay>
                                <source :src="getVideoSrc(item)"
                                    type="video/mp4">
                                现在还有不支持 video tag 的浏览器吗？
                            </video>
                        </div>
                        <span v-else-if="item.type == 'video'" class="msg-unknown">
                            {{ '( ' + $t('视频无法播放，文件可能已被清理') + ' )' }}
                        </span>
                        <template v-else-if="item.type == 'record'">
                            <VoiceMsg
                                :item="item"
                                :message-id="String(data.message_id)"
                                :is-me="isMe" />
                        </template>
                        <template v-else-if="item.type == 'forward'">
                            <div class="msg-raw-forward"
                                @click="openMerge()">
                                <span>{{ $t('合并转发消息') }}</span>
                                <div class="forward-msg">
                                    <template v-if="item.content && item.content.length > 0">
                                        <div v-for="(i, indexItem) in item.content.slice(0, 3)"
                                            :key="'raw-forward-' + indexItem">
                                            {{ i.sender.nickname }}:
                                            <span v-for="(msg, msgIndex) in i.message"
                                                :key="'raw-forward-item-' + msgIndex">
                                                <span v-if="msg.type == 'text'">
                                                    {{ msg.text }}
                                                </span>
                                                <span v-else-if="msg.type == 'image'">
                                                    [{{ $t('图片') }}]
                                                </span>
                                                <span v-else-if="msg.type == 'face' || msg.type == 'bface'">
                                                    [{{ $t('表情') }}]
                                                </span>
                                                <span v-else-if="msg.type == 'file'">
                                                    [{{ $t('文件') }}]{{ msg.data.file }}
                                                </span>
                                                <span v-else-if="msg.type == 'video'">
                                                    [{{ $t('视频') }}]
                                                </span>
                                                <span v-else-if="msg.type == 'record'">
                                                    [{{ $t('语音') }}]
                                                </span>
                                                <span v-else-if="msg.type == 'forward'">
                                                    [{{ $t('聊天记录') }}]
                                                </span>
                                                <span v-else-if="msg.type == 'reply'">
                                                    <!--原版QQ此处不做处理-->
                                                </span>
                                                <span v-else>
                                                    [{{ $t('不支持的消息') }}]
                                                </span>
                                            </span>
                                        </div>
                                    </template>
                                    <div v-else>
                                        {{ $t('加载失败') }}
                                    </div>
                                </div>
                                <div>
                                    <span v-if="item.content !== undefined">
                                        {{ $t('查看 {count} 条转发消息', { count: item.content.length }) }}
                                    </span>
                                    <span v-else>
                                        {{ $t('聊天记录') }}
                                    </span>
                                </div>
                            </div>
                        </template>
                        <div v-else-if="item.type == 'reply'"
                            v-show="type != 'body'"
                            :class="isMe ? type == 'merge' ? 'msg-replay' : 'msg-replay me' : 'msg-replay'"
                            @click="jumpToReply(item.id)">
                            <div>
                                <span>{{ getMsgInfo(item.id) }}</span>
                                <font-awesome-icon v-if="getMsgInfo(item.id) != ''" :icon="['fas', 'turn-up']" />
                            </div>
                            <MsgBody v-if="getMsg(item.id)"
                                :data="getMsg(item.id, true)"
                                :type="'body'"
                                :global-me="isMe ? 'Y' : ''" />
                            <a v-else v-reply-backfill="replyPreviewNeed(item.id)" class="msg-unknown">
                                {{ getMsgStr(item.id) != '' ? getMsgStr(item.id) : $t('（查看回复消息）') }}
                            </a>
                        </div>
                        <div v-else-if="item.type == 'poke'" v-once :class="showPock()">
                            <font-awesome-icon class="poke-hand" style="margin-right: 5px;" :icon="['fas', 'fa-hand-point-up']" />
                            {{ $t('戳了戳你') }}
                        </div>
                        <span v-else class="msg-unknown">{{ '( ' + $t('不支持的消息') + ': ' + item.type + ' )' }}</span>
                    </div>
                </template>
                <template v-else>
                    <JsonSegComp v-if="data.message.at(0)!.type === 'json'"
                        :data="data.message.at(0)!.data" />
                    <XmlSegComp v-else :id="data.message_id" :item="data.message.at(0)!.data" />
                </template>
                <!-- 链接预览框 -->
                <div v-if="!isDebugMsg && pageViewInfo && Object.keys(pageViewInfo).length > 0"
                    :class="'msg-link-view ' + linkViewStyle">
                    <template v-if="pageViewInfo.type == undefined">
                        <div :class="'bar' + (isMe ? ' me' : '')" />
                        <div>
                            <img v-if="pageViewInfo.img !== undefined"
                                alt="预览图片"
                                title="查看图片"
                                :src="pageViewInfo.img"
                                @load="linkViewPicFin"
                                @error="linkViewPicErr"
                                @click="preImgClick(pageViewInfo.img)">
                            <div class="body">
                                <p v-show="pageViewInfo.site">
                                    {{ pageViewInfo.site }}
                                </p>
                                <span :href="pageViewInfo.url">{{
                                    pageViewInfo.title
                                }}</span>
                                <span>{{ pageViewInfo.desc }}</span>
                            </div>
                        </div>
                    </template>
                    <template v-else>
                        <!-- 特殊 URL 的预览 -->
                        <div v-if="pageViewInfo.type == 'bilibili'"
                            class="link-view-bilibili"
                            @click="openLink(pageViewInfo.url)">
                            <div class="user">
                                <img :src="backend.proxyUrl(pageViewInfo.data.owner.face)">
                                <span>{{ pageViewInfo.data.owner.name }}</span>
                                <a>{{ Intl.DateTimeFormat(trueLang, {
                                    year: 'numeric',
                                    month: 'numeric',
                                    day: 'numeric',
                                    hour: 'numeric',
                                    minute: 'numeric'
                                }).format(getViewTime(pageViewInfo.data.public)) }}</a>
                            </div>
                            <img :src="backend.proxyUrl(pageViewInfo.data.pic)">
                            <span>{{ pageViewInfo.data.title }}</span>
                            <a>{{ pageViewInfo.data.desc }}</a>
                            <div class="data">
                                <font-awesome-icon :icon="['fas', 'play']" />
                                {{ pageViewInfo.data.stat.view }}
                                <font-awesome-icon :icon="['fas', 'coins']" />
                                {{ pageViewInfo.data.stat.coin }}
                                <font-awesome-icon :icon="['fas', 'star']" />
                                {{ pageViewInfo.data.stat.favorite }}
                                <font-awesome-icon :icon="['fas', 'thumbs-up']" />
                                {{ pageViewInfo.data.stat.like }}
                            </div>
                        </div>
                        <div v-else-if="pageViewInfo.type == 'music163'" style="width: 100%;">
                            <div class="link-view-music163">
                                <div>
                                    <a>{{ pageViewInfo.data.info.name }}
                                        <a v-if="pageViewInfo.data.info.free != null">{{ $t('（试听）') }}</a>
                                    </a>
                                    <span>{{ pageViewInfo.data.info.author.join('/') }}</span>
                                </div>
                                <img :src="pageViewInfo.data.cover">
                                <font-awesome-icon
                                    :icon="['fas', 'play']"
                                    :class="{ light: pageViewInfo.data.cover_light }"
                                    @click="sendPlay({
                                        title: pageViewInfo.data.info.name,
                                        author: pageViewInfo.data.info.author,
                                        url: pageViewInfo.data.play_link,
                                        type: 'music163',
                                        cover: pageViewInfo.data.cover,
                                        free: pageViewInfo.data.info.free,
                                        time: pageViewInfo.data.info.time,
                                        data: pageViewInfo.data.id,
                                    })" />
                            </div>
                        </div>
                    </template>
                </div>
            </div>
        </div>
        <div v-if="data.fake_msg == true"
            :class="'sending right' + (isMe ? ' me' : '')">
            <font-awesome-icon :icon="['fas', 'spinner']" />
        </div>
        <div v-if="data.emoji_like"
            :class="'emoji-like' + (isMe ? ' me' : '')">
            <div class="emoji-like-body">
                <TransitionGroup name="emoji-like">
                    <template v-for="info, id in data.emojis" :key="'respond-' + data.message_id + '-' + id">
                        <div :class="{
                            'me-send': info.includes(authStore.loginInfo.uin),
                        }">
                            <EmojiFace :emoji="Emoji.get(Number(id))!" />
                            <span>{{ info.length }}</span>
                        </div>
                    </template>
                </TransitionGroup>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import Option from '@renderer/function/option'
import markdownit from 'markdown-it'

import { MsgBodyFuns as ViewFuns } from '@renderer/function/model/msg-body'
import { watch, onMounted, nextTick, provide, inject, useTemplateRef, ref, toRaw } from 'vue'
import { Connector } from '@renderer/function/connect'
import { useSettingsStore } from '@renderer/state/settings'
import { Logger, LogType, PopInfo, PopType } from '@renderer/function/base'
import { StringifyOptions } from 'querystring'
import {
    getMsgRawTxt,
    pokeAnime,
    getImageInfo,
    rememberImageSize,
    rememberImageTone,
    readImageMimeFromBase64,
} from '@renderer/function/utils/msgUtil'
import {
    isRobot,
    openLink,
    sendStatEvent,
	vMenu,
	vMove,
	VMoveOptions,
} from '@renderer/function/utils/appUtil'
import { vUserTooltip } from '@renderer/function/tooltip'
import { vReplyBackfill } from '@renderer/function/replyPreview'
import {
    getForegroundToneGridFromImageUrl,
    getSizeFromBytes,
    getTimeConfig,
    getTrueLang,
    getViewTime } from '@renderer/function/utils/systemUtil'
import { linkView } from '@renderer/function/utils/linkViewUtil'
import { MenuEventData, MergeStackData } from '@renderer/function/elements/information'
import { backend } from '@renderer/runtime/backend'
import { i18n } from '@renderer/main'
import { useUIStore } from '@renderer/state/ui'
import { useAuthStore } from '@renderer/state/auth'
import { useContactStore } from '@renderer/state/contact'
import { useChatStore } from '@renderer/state/chat'

const uiStore = useUIStore()
const authStore = useAuthStore()
const contactStore = useContactStore()
const chatStore = useChatStore()
const settingsStore = useSettingsStore()
import Emoji from '@renderer/function/model/emoji'
import EmojiFace from './EmojiFace.vue'
import LazyLottie from './LazyLottie.vue'
import { Img } from '@renderer/function/model/img'
import { dbGetImage, hashUrl } from '@renderer/function/utils/localHistoryUtil'
import JsonSegComp from './msg-component/JsonSegComp.vue'
import XmlSegComp from './msg-component/XmlSegComp.vue'
import VoiceMsg from './VoiceMsg.vue'
import { addMusic, MusicInfo } from '@renderer/state/musicPlayer'

type Msg = any
type IUser = any

defineOptions({ name: 'MsgBody' })

const $t = i18n.global.t

const {
    data,
    selected,
    type,
    globalMe,
    imageListHeader,
} = defineProps<{
    data: any
    selected?: boolean
    type?: 'merge' | 'body'
    globalMe?: string
    imageListHeader?: Img | undefined
}>()

provide('message-content', data)

const { viewer: viewerRef } = inject<{ viewer: any }>('viewer', { viewer: null })

const emit = defineEmits<{
    jumpReply: [message_id: string]
    sendPoke: [...args: any[]]
    leftMove: [msg: Msg]
    rightMove: [msg: Msg]
    showMenu: [event: MenuEventData, msg: Msg]
}>()

const msgMain = useTemplateRef<HTMLDivElement>('msgMain')

const moveOptions: VMoveOptions<HTMLDivElement> = {
    moveHook: (_, move: number) => {
        const target = msgMain.value!
        target.style.transform = 'translateX(' + move + 'px)'
    },
    endHook: (_) => {
        const target = msgMain.value!

        target.style.transform = ''
        target.style.transition = 'all 0.3'
    },
    leftLimit: {
        value: uiStore.inch * 0.75,
        type: 'px'
    },
    rightLimit: {
        value: uiStore.inch * 0.75,
        type: 'px'
    },
    moveCondition: {
        minMove: {
            value: uiStore.inch * 0.5,
            type: 'px'
        }
    }
}

//#endregion

//#region == 响应式状态 ================================================================

const View = ViewFuns
const md = markdownit({ breaks: true })
const isMe = ref(false)
const isDev = import.meta.env.DEV
const msgBodyClass = ref('message-body')
const isDebugMsg = Option.get('debug_msg')
const linkViewStyle = ref('')
const pageViewInfo = ref(undefined as { [key: string]: any } | undefined)
const gotLink = ref(false)
const senderInfo = ref(null as any)
const trueLang = getTrueLang()
const textIndex = ref({} as { [key: string]: number })
const resolvedImages = ref({} as Record<string, string>)
const manualImageLoads = ref({} as Record<string, boolean>)
const pendingImageLoads = ref({} as Record<string, boolean>)

//#endregion

//#region == 工具函数 ================================================================

function getAtMember(id: number): IUser | number {
    const re = getUserById(id) ?? id
    return re
}
function getUserById(id: number): IUser | undefined {
    if (chatStore.chatInfo.show.type === 'group') {
        if (!chatStore.chatInfo.info.group_members) return id
        const user = chatStore.chatInfo.info.group_members.find((item: IUser) => item.user_id == id)
        if (user) return user
        else return id
    }else {
        const user = contactStore.userList.find((item: IUser) => item.user_id === id)
        if (user) return user
        else return id
    }
}

//#endregion

//#region == 方法函数 ================================================================

async function loadCachedImages() {
    const selfId = authStore.loginInfo?.uin
    if (!selfId) return
    for (const seg of data.message) {
        if (seg.type !== 'image' || !seg.url) continue
        await loadCachedImage(seg.url)
    }
}

async function loadCachedImage(url: string) {
    if (resolvedImages.value[url]) return resolvedImages.value[url]

    const selfId = authStore.loginInfo?.uin
    if (!selfId || !url) return undefined

    const urlHash = await hashUrl(url)
    const cached = await dbGetImage(selfId, urlHash)
    if (cached) {
        // 不能直接信库里存的类型：早期版本的本地反代把所有响应的 Content-Type 写死成
        // text/html，那段时间缓存下来的图片就带着这个假类型躺在库里。而 data: URL 的内容
        // 嗅探是被关掉的（声明什么就按什么解析），照搬这个头等于给每一张老缓存判死刑。
        // 字节就在手上，按签名认一遍；认不出来才用存的值，且只接受 image/*。
        const stored = typeof cached.mimeType === 'string' ? cached.mimeType : ''
        const mimeType = readImageMimeFromBase64(cached.data)
            ?? (stored.startsWith('image/') ? stored : 'image/jpeg')
        resolvedImages.value[url] = `data:${mimeType};base64,${cached.data}`
        return resolvedImages.value[url]
    }

    return undefined
}

function getImgSrc(url: string): string {
    return resolvedImages.value[url] ?? backend.proxyUrl(url)
}

/**
 * 取视频段真正能播的地址，拿不到就返回空串（调用处据此降级成纯文本）。
 *
 * OneBot 的 url 字段并不保证一定是地址：NapCat 的 videoElement 在拿播放地址失败时
 * catch 里回落到 filePath，也就是把 QQ 容器里的本地路径原样塞进 url。这种值一旦写进
 * <source src>，webview 会把它当相对路径去请求 → 404，界面上留下来一个永远转圈的
 * 死播放器，比直接说明播放不了更糟。所以这里只放行确实能取的协议。
 */
function getVideoSrc(item: { url?: string }): string {
    const url = item.url
    if (typeof url !== 'string' || url.length === 0) return ''

    if (url.startsWith('base64://')) return 'data:video/mp4;base64,' + url.substring(9)
    if (url.startsWith('data:') || url.startsWith('blob:')) return url
    if (url.startsWith('http://') || url.startsWith('https://')) return url

    return ''
}

function getImageKey(index: number, url: string) {
    return `${data.message_id}-${index}-${url}`
}

function imageLoading(key: string) {
    return pendingImageLoads.value[key] === true
}

function shouldShowImagePlaceholder(item: { type: string, url: string }, index: number) {
    if (item.type !== 'image') return false
    if (settingsStore.sysConfig.opt_no_auto_load_image !== true) return false

    return manualImageLoads.value[getImageKey(index, item.url)] !== true
}

function getAtClass(who: number | string) {
    let back = 'msg-at'
    if (isMe.value && type != 'merge') {
        back += ' me'
    }
    if (authStore.loginInfo.uin == who || who == 'all') {
        back += ' atme'
    }
    return back
}

function getAtName(item: { [key: string]: any }) {
    if (item.qq == 'all') {
        return '@' + $t('全体成员')
    }
    if (item.text != undefined) {
        return item.text
    } else {
        for (let i = 0; i < chatStore.chatInfo.info.group_members.length; i++) {
            const user = chatStore.chatInfo.info.group_members[i]
            if (user.user_id == Number(item.qq)) {
                return ('@' + (user.card != '' && user.card != null? user.card: user.nickname))
            }
        }
        return '@' + item.qq
    }
}

/**
 * 点回复引用 → 把目标消息 id 交给聊天页去定位。
 *
 * 这里只传 id，不拼 chat- 前缀：目标可能压根不在当前分页窗口里（引用的多半是
 * 老消息），定位它要拉取甚至要把它提升进列表，那套上下文只有 Chat.vue 有。
 */
function jumpToReply(id: string) {
    emit('jumpReply', id)
}

/**
 * 这一行的回复目标还没在手上就返回要补拉的 id，否则返回空串。
 * 只看「在不在分页窗口 / 开着的合并转发里」：缓存里已经有、或者已经确认拿不到的，
 * 都不再请求。
 */
function replyPreviewNeed(message_id: string) {
    if (!message_id) return ''
    if (chatStore.messageList.some((item) => item.message_id == message_id)) return ''
    if (findInMergeStack(message_id)) return ''
    if (chatStore.replyPreviewMap.has(String(message_id))) return ''
    return String(message_id)
}

function imgStyle(length: number, at: number, isFace: boolean) {
    let style = 'msg-img'
    if (type == 'body') {
        return style
    }
    if (isFace) {
        style += ' face'
    }
    if (length === 1) {
        return (style += ' alone')
    }
    if (at === 0) {
        return (style += ' top')
    }
    if (at === length - 1) {
        return (style += ' button')
    }
    return style
}

/**
 * 图片按 max-height: 35vh 缩放之后该有的宽度，写成 CSS 表达式（--width 的取值）。
 * imageLoaded 量完自然尺寸要用一次，模板里提前占位也要用一次 —— 这个算法只留一份，
 * 免得两处各算各的、日后改了一处漏了另一处。
 *
 * 为什么交给 CSS 算、而不是在这里乘出个 px：35vh 跟着窗口高度变，而这个函数只在
 * imageInfos 变化时才会被重新调用一次 —— 窗口 resize 既不触发模板重渲染（MsgBody
 * 不消费 useViewportUnits 那对响应式 vw/vh），也没有任何 ResizeObserver 挂在图片上。
 * 快照成 px 的后果实测（WebKitGTK 4.1，真实 msg.css）：400x600 的图在 900px 高的
 * 窗口里占 210x315，把窗口缩到 450 高，宽度还是 210、max-height 却降成 157，
 * 图被纵向压扁一半 —— 而且是每个占好位的图都扁，缩多少扁多少。
 * 写成 min() / calc() 之后，宽度每次布局都由引擎按当前 vh 重算，两者永远同步；
 * 窄图（天然高度没到 35vh）min() 取的是天然宽度，和原来逐个像素一致。
 */
function imageWidthCss(naturalWidth: number, naturalHeight: number) {
    return `min(${naturalWidth}px, calc(35vh * ${naturalWidth / naturalHeight}))`
}

/** 长图（宽高比 > 2.5）的判据。宽高比在解码前就知道，所以这个判断能提前做。 */
function isLongImage(url: string) {
    const info = getImageInfo(url)
    return info !== undefined && info.h / info.w > 2.5
}

/**
 * 已经量到尺寸的图片，提前挂上的 class。.long-img 是固定尺寸（width 20vw /
 * height 40vh / object-fit: cover），晚一步挂就等于解码之后再把布局翻一次。
 *
 * 这里是这两个 class 的唯一来源：解码后的 imageLoaded 不再自己 classList.add，
 * 否则模板下一次重渲染时 Vue 会拿绑定值整个覆盖 className，把它抹掉。
 */
function preImgClass(url: string) {
    if (!isLongImage(url)) return ''
    return getImageInfo(url)?.light ? ' long-img light' : ' long-img'
}

/**
 * 已经量到尺寸的图片，解码之前就把占位盒交出去。没量到就什么都不给（那一行解码时会
 * 撑开，视口要不要跟着走由 chatViewport 按「视口底边那点内容有没有动」判断）。
 *
 * width / height 属性管的是「原始尺寸」，`--width` 管表情图的 max-width
 * （calc(var(--width) / 2 + 20px)，以前要等解码后由 imageLoaded 写入，在那之前它是
 * 无效值、max-width 退回 none，解码完再缩一次）。
 *
 * 但只给这两个属性**占不住高度**：`.msg-img` 上有一条 `height: auto`（msg.css，用来
 * 盖掉 width/height 属性自带的那条 height: 200px 表现性提示，不然图会被纵向拉变形），
 * 于是高度只能由「内在比例」推 —— 而字节还没到的 <img> 没有内在比例，WebKit 会退回
 * 一个和真实比例无关的高度。实测（WebKitGTK 4.1，真实 msg.css，400x600 的图）：
 * 只绑属性时出生框 281x191，解码后 281x422，这一行在解码时凭空长高 231px。这 231px
 * 就长在视口里：滚动锚定只能补「视口底边之下」的高度，视口内部长高就是用户看的那些
 * 内容自己被挤开 —— 没有任何补滚动的位置能救（这也正是它必须被提前占住的原因）。
 *
 * 所以比例必须显式写在盒子上：aspect-ratio 让第一帧就有确定的比例可算，出生框和
 * 解码后的框逐像素相等（同一场景实测两次都是 281x422，撑开量 0 —— 解码只是往已经
 * 占好的框里填内容，列表高度自始至终一个像素不变）。这才是「先把盒子占住」；只给
 * 宽高属性、让高度等解码，那是「先给个大概、解码后再挪」，挪的正是视口里的内容。
 *
 * 但只有 aspect-ratio 也还不够：只要宽度是被指定死的（width 属性本身就是一条写死的
 * width: 400px），max-height: 35vh 那次高度收窄就**不会**反推回宽度 —— WebKit 把高度
 * 压到 315px 之后，宽度仍是按原始尺寸折算出来的 281px，比例从 0.667 变成 0.893，
 * 图被横向拉宽 34%（实测 WebKitGTK 4.1：400x600 渲染成 281.4x315）。所以宽度要先自己
 * 按 35vh 折好再写上去（就是 imageWidthCss 那个表达式），让高度顺着比例推出来正好也是
 * 315px —— 两端都落在最终框里，谁也不去压谁，图才是原始比例、也是它该有的大小。
 * 反过来的 max-width（宽图那条）不用管：它压的是宽度、高度是 auto 会跟着重算，比例不丢。
 */
/**
 * 尺寸还没量到时的预估占位框（自然尺寸 480x360，4:3）。
 *
 * 为什么要有它：等待探测是有上限的（msgUtil 的 PRELOAD_WAIT_CAP_*，Signal / Telegram
 * 不用等是因为宽高跟着消息元数据走，OneBot 段里没有，只能现量）。慢网络下探测赶不上
 * 上限时，没有预估框的那一行出生是零高，等探测 / 解码落定才长到全高 —— 纠正量是整张
 * 图那么高。给一个中性预估框之后，纠正量只剩「预估和实际的差」（聊天图大多是 4:3 /
 * 3:4 / 16:9，差值通常在几十像素），再交给 chatViewport 锚定兜住。
 *
 * 只在普通图片上用（模板里 estimate=true 的那一处）：表情图（marketface / mface）不给 ——
 * 它们的真尺寸远小于这个框，预估错得离谱，还不如不占。
 *
 * 量到尺寸后 imageInfos 是响应式的，这个函数会被重算，框自动换成真实比例 —— 预估框的
 * 生命周期只有「探测慢于等待上限」那一小段。
 */
const FALLBACK_IMAGE_SIZE = { w: 480, h: 360 }

function preSize(url: string, estimate = false) {
    const info = getImageInfo(url)
    if (!info) {
        if (!estimate) return undefined
        const width = imageWidthCss(FALLBACK_IMAGE_SIZE.w, FALLBACK_IMAGE_SIZE.h)
        return {
            style: {
                '--width': width,
                'aspect-ratio': `${FALLBACK_IMAGE_SIZE.w} / ${FALLBACK_IMAGE_SIZE.h}`,
                width,
            },
        }
    }
    const long = isLongImage(url)
    // 长图那套固定框（20vw x 40vh）本来就是相对单位，宽度只有 --width 这一个用途。
    const width = long ? `${info.w}px` : imageWidthCss(info.w, info.h)
    return {
        width: info.w,
        height: info.h,
        style: {
            '--width': width,
            'aspect-ratio': `${info.w} / ${info.h}`,
            // 长图另有自己那套固定框（.long-img：20vw x 40vh + object-fit: cover），
            // 内联宽度会盖掉 .long-img 的 20vw，所以这里不给。
            ...(long ? {} : { width }),
        },
    }
}

function imgClick(url: string) {
    if (viewerRef?.value && imageListHeader) {
        viewerRef.value.openBySrc(imageListHeader, url)
    }
}

async function loadImage(item: { url: string }, index: number) {
    const key = getImageKey(index, item.url)
    if (manualImageLoads.value[key] || pendingImageLoads.value[key]) return

    pendingImageLoads.value[key] = true
    try {
        if (data._from_local_db) {
            await loadCachedImage(item.url)
        }
        manualImageLoads.value[key] = true
    } finally {
        pendingImageLoads.value[key] = false
    }
}

function preImgClick(img: string) {
    if (viewerRef?.value) {
        viewerRef.value.open(new Img(img))
    }
}

async function imageLoaded(event: Event) {
    const img = event.target as HTMLImageElement

    if(backend.isMobile() && img.src && !img.src.startsWith('data:')
        && img.dataset.type === 'image') {
        img.src = await backend.proxyImageUrl(img.src)
        return
    }

    // 把量到的信息记进共享缓存：这条消息下次再渲染（往回翻、切会话回来）时，模板里的
    // preSize / preImgClass 就能在解码之前把框和 class 一次摆好。长图的 .long-img 也
    // 从缓存出去 —— 这里不再手动 classList.add，免得模板下次重渲染时 Vue 用绑定值整个
    // 覆盖 className 把它抹掉。赋值发生在 await 之前，重渲染赶在取色完成前就落地。
    const imgUrl = img.dataset.imgUrl
    if (imgUrl) rememberImageSize(imgUrl, img.naturalWidth, img.naturalHeight)

    const imgHeight = img.naturalHeight || img.height
    const imgWidth = img.naturalWidth || img.width

    // 缩放算法在 imageWidthCss 里，模板提前占位用的是同一份
    const isLongImg = imgHeight / imgWidth > 2.5
    if (!isLongImg && imgWidth > 0 && imgHeight > 0)
        img.style.setProperty('--width', imageWidthCss(imgWidth, imgHeight))

    // 这一行会不会因为解码长高、长高之后视口该不该跟着走，都不在这里判断 —— 聊天面板
    // 的滚动位置只有 chatViewport 一份实现：它挂着 ResizeObserver 看列表容器的高度，
    // 按「视口底边那点内容有没有动」决定补多少。这里只负责把量到的尺寸交出去，让下一
    // 次渲染能提前占住框。

    // 取色是异步的、必然晚于尺寸到，放在最后：它只写 .long-img.light 的角标颜色，
    // 不动布局，晚一点没有关系。
    if (isLongImg) {
        try {
            const picLight = ( await getForegroundToneGridFromImageUrl(backend.proxyUrl(img.src), 0.4))[1][1] === 'light'
            if(picLight && imgUrl) rememberImageTone(imgUrl, true)
        } catch {
            // do nothing
        }
    }
}

function imgLoadFail(event: Event) {
    const sender = event.currentTarget as HTMLImageElement
    const parent = sender.parentNode as HTMLDivElement
    parent.style.display = 'flex'
    parent.style.flexDirection = 'column'
    parent.style.alignItems = 'center'
    parent.style.padding = '20px 50px'
    parent.style.border = '2px dashed var(--color-card-2)'
    parent.style.borderRadius = '10px'
    parent.style.margin = '10px 0'
    parent.innerText = ''
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 512 512')
    svg.innerHTML =
        '<path d="M119.4 44.1c23.3-3.9 46.8-1.9 68.6 5.3l49.8 77.5-75.4 75.4c-1.5 1.5-2.4 3.6-2.3 5.8s1 4.2 2.6 5.7l112 104c2.9 2.7 7.4 2.9 10.5 .3s3.8-7 1.7-10.4l-60.4-98.1 90.7-75.6c2.6-2.1 3.5-5.7 2.4-8.8L296.8 61.8c28.5-16.7 62.4-23.2 95.7-17.6C461.5 55.6 512 115.2 512 185.1v5.8c0 41.5-17.2 81.2-47.6 109.5L283.7 469.1c-7.5 7-17.4 10.9-27.7 10.9s-20.2-3.9-27.7-10.9L47.6 300.4C17.2 272.1 0 232.4 0 190.9v-5.8c0-69.9 50.5-129.5 119.4-141z"/>'
    svg.style.width = '40px'
    svg.style.opacity = '0.8'
    svg.style.fill = 'var(--color-main)'
    if (isMe.value) {
        svg.style.fill = 'var(--color-font-r)'
    }
    parent.appendChild(svg)
    const span = document.createElement('span')
    span.innerText = $t('加载图片失败')
    span.style.marginTop = '10px'
    span.style.fontSize = '0.8rem'
    span.style.color = 'var(--color-font-2)'
    if (isMe.value) {
        span.style.color = 'var(--color-font-1-r)'
    }
    parent.appendChild(span)
    const a = document.createElement('a')
    a.innerText = $t('预览图片')
    a.target = '__blank'
    a.href = sender.src
    a.style.marginTop = '10px'
    a.style.fontSize = '0.7rem'
    a.style.color = 'var(--color-font-2)'
    if (isMe.value) {
        a.style.color = 'var(--color-font-1-r)'
    }
    parent.appendChild(a)
}

async function parseText(index: number) {

    let text = data.message[index].text

    const logger = new Logger()
    text = ViewFuns.parseText(text)
    const filtedText = text.replace(/(.)(\1{10,})/g, '$1<span style="opacity:0.7;margin-right:10px;">...</span>')
    if(filtedText != text) {
        const style = 'display:block;margin-top:10px;opacity:0.7;cursor:pointer;'
        text = filtedText + '<a style="' + style +'" data-raw="' + text + '" onclick="this.parentNode.innerText = this.dataset.raw;return false;">' + $t('显示原始消息') + '</a>'
    }

    if(type == 'body') {
        textIndex.value[index] = text
        return
    }

    const reg = /(http|https):\/\/[\w\-_]+(\.[\w\-_]+)+([\w\-.,@?^=%&:/~+#]*[\w\-@?^=%&/~+#])?/gi
    text = text.replaceAll(reg, '<a href="" data-link="$&" onclick="return false">$&</a>')
    const linkList = text.match(reg)
    if (linkList !== null && !gotLink.value && !isDebugMsg) {
        queueMicrotask(async() => {
            gotLink.value = true
            const fistLink = linkList[0]
            let protocol = ''
            let domain = ''
            try {
                protocol = new URL(fistLink).protocol + '//'
                domain = new URL(fistLink).hostname
            } catch (ignore) {
                // ignore
            }
            sendStatEvent('link_view', { domain: domain })

            let linkData = null as any
            let finaLink = fistLink
            try {
                finaLink = await backend.call('Onebot', 'sys:getFinalRedirectUrl', true, fistLink)
                if(!finaLink) {
                    finaLink = fistLink
                }
            } catch(_) { /**/ }
            const showLinkList = {
                bilibili: ['bilibili.com', 'b23.tv', 'bili2233.cn', 'acg.tv'],
                music163: ['music.163.com', '163cn.tv'],
            }
            for (const key in showLinkList) {
                if (showLinkList[key].some((item: string) => finaLink.includes(item))) {
                    linkData = await linkView[key](finaLink)
                }
            }
            if(!linkData) {
                if (!backend.isWeb()) {
                    let html = await backend.call('Onebot', 'sys:getHtml', true, finaLink)
                    if(html) {
                        const headEnd = html.indexOf('</head>')
                        html = html.slice(0, headEnd)
                        const ogRegex = /<meta\s+property="og:([^"]+)"\s+content="([^"]+)"\s*\/?>/g
                        const ogTags = {} as {[key: string]: string}
                        let match: string[] | null
                        while ((match = ogRegex.exec(html)) !== null) {
                            ogTags[`og:${match[1]}`] = match[2]
                        }
                        linkData = ogTags
                    }
                } else {
                    const response = await fetch(`${import.meta.env.VITE_APP_LINK_VIEW}/${encodeURIComponent(fistLink)}`)
                    if(response.ok) {
                        const res = await response.json()
                        if (res.status === undefined && Object.keys(res).length > 0) {
                            linkData = res
                        }
                    }
                }
            }

            logger.add(LogType.DEBUG, 'Link View: ', linkData)
            if(linkData) {
                loadLinkPreview(protocol + domain, linkData)
            }
        })
    }
    textIndex.value[index] = text
}

function loadLinkPreview(domain: string, res: any) {
    const logger = new Logger()
    logger.debug('获取链接预览成功: ' + res['og:title'])
    if(res != undefined) {
        if (res.type == undefined) {
            if(Object.keys(res).length > 0) {
                let imgUrl = res['og:image']
                if (imgUrl && !imgUrl.startsWith('http') && !imgUrl.startsWith('www')) {
                    imgUrl = new URL(imgUrl.startsWith('/') ? imgUrl : '/' + imgUrl, domain).toString()
                }
                const pageData = {
                    site: res['og:site_name'] === undefined ? '' : res['og:site_name'],
                    title: res['og:title'] === undefined ? '' : res['og:title'],
                    desc: res['og:description'] === undefined ? '' : res['og:description'],
                    img: imgUrl,
                    link: res['og:url'],
                }
                pageViewInfo.value = pageData
            }
        } else {
            pageViewInfo.value = res
        }
    }
}

function linkViewPicFin(event: Event) {
    // 直接用事件里的元素，不再拿 message_id 拼个 id 去 document 里找：同一个
    // message_id 会被渲染两次（列表里一份、引用预览里一份），id 就重复了，
    // getElementById 只会返回先出现的那份，很可能量到的是隐藏副本的尺寸。
    const img = event.target as HTMLImageElement
    if (img.naturalWidth > img.naturalHeight) {
        linkViewStyle.value = 'large'
    }
}
function linkViewPicErr() {
    if(pageViewInfo.value)
        pageViewInfo.value.img = undefined
}

function hiddenUserInfo() {
    if (chatStore.chatInfo.info.now_member_info !== undefined) {
        chatStore.chatInfo.info.now_member_info = undefined
    }
}

/**
 * 在开着的合并转发内容里找一条消息。
 *
 * 为什么要翻这里：转发的就是一整段聊天记录，转发里的回复，被引用的那条多半就躺在
 * 同一份转发内容里；而主聊天列表里反而多半没有它（那段记录发生在别的时间/别的群）。
 * 嵌套转发（content 里再套 content）也一起走 —— 打开第二层转发时它已经被推进
 * mergeMsgStack，但第一层里的回复也可能引用嵌套层里的消息。
 */
function findInMergeStack(message_id: string): any {
    const walkMsgs = (msgs: any[]): any => {
        for (const m of msgs ?? []) {
            if (m?.message_id == message_id) return m
            for (const seg of m?.message ?? []) {
                if (Array.isArray(seg?.content)) {
                    const hit = walkMsgs(seg.content)
                    if (hit) return hit
                }
            }
        }
        return undefined
    }
    for (const stackData of chatStore.mergeMsgStack) {
        const hit = walkMsgs(stackData.messageList)
        if (hit) return hit
    }
    return undefined
}

/**
 * 按 id 找一条消息：先看分页窗口，再看开着的合并转发内容，最后看回复预览的补拉缓存。
 * 缓存里 null 表示确认拿不到，此时返回 null，预览保持占位。
 */
function findMsg(message_id: string) {
    const list = chatStore.messageList.filter((item) => {
        return item.message_id == message_id
    })
    if (list.length === 1) return list[0]
    const inMerge = findInMergeStack(message_id)
    if (inMerge) return inMerge
    return chatStore.replyPreviewMap.get(String(message_id)) ?? null
}

function getMsgInfo(message_id: string) {
    const msg = findMsg(message_id)
    if (msg && msg.message.length > 0) {
        const time = Intl.DateTimeFormat(trueLang,
                getTimeConfig(new Date(getViewTime(msg.time))))
            .format(getViewTime(getViewTime(msg.time)))
        return (msg.sender.nickname + ' ' + time)
    }
    else return ''

}

function getMsgStr(message_id: string) {
    const msg = findMsg(message_id)
    if (msg) {
        return getMsgRawTxt(msg)
    }
    return ''
}

function getMsg(message_id: string, filter: boolean = false) {
    const found = findMsg(message_id)
    const list = found ? [found] : []
    if (list.length === 1) {
        const msg = toRaw(list[0])
        const textFallbackTypes = new Set([
            'video',
            'record',
            'file',
            'json',
            'xml',
            'forward'
        ])
        const needTextFallback = (msg.message ?? []).some((seg: any) => textFallbackTypes.has(seg?.type))
        if (needTextFallback) {
            return filter ? null : false
        }
        if(filter) {
            const mediaTypes = new Set([
                'image',
                'mface',
                'forward',
            ])
            let hasMedia = false
            const message = (msg.message ?? []).filter((seg: any) => {
                if (!mediaTypes.has(seg?.type)) {
                    return true
                }
                if (hasMedia) {
                    return false
                }
                hasMedia = true
                return true
            })
            return {
                ...msg,
                message,
            }
        } else {
            return list[0]
        }
    }
    return null
}

function downloadFile(fileData: any, message_id: string) {
    let name = authStore.jsonMap.file_download?.private_name
    if(chatStore.chatInfo.show.type == 'group') {
        name = authStore.jsonMap.file_download?.name
    }
    Connector.send(name, {
        file_id: fileData.file_id,
        group_id: chatStore.chatInfo.show.type == 'group' ? chatStore.chatInfo.show.id : undefined,
    },
        'downloadFile_' + message_id + '_' + btoa(encodeURIComponent(fileData.name ?? fileData.file_name)),
    )
}

function textClick(event: Event) {
    const target = event.target as HTMLElement
    if (target.dataset.link) {
        const link = target.dataset.link
        openLink(link)
    }
}

function loadFileBase(
    fileData: any,
    name: string,
    message_id: StringifyOptions,
) {
    const ext = name.split('.').pop()
    const msg = chatStore.messageList.find(
        (item) => item.message_id === message_id,
    )
    if (ext && msg?.fileView == undefined) {
        const list = [
            'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp',
            'mp4', 'avi', 'mkv', 'flv',
            'txt', 'md',
        ]
        if (list.includes(ext)) {
            msg.fileView = {}
            let dlName = authStore.jsonMap.file_download?.private_name
            if(chatStore.chatInfo.show.type == 'group') {
                dlName = authStore.jsonMap.file_download?.name
            }
            if(dlName) {
                Connector.send(dlName, {
                    file_id: fileData.file_id,
                    group_id: chatStore.chatInfo.show.type == 'group' ? chatStore.chatInfo.show.id : undefined,
                },
                    'loadFileBase_' + data.message_id + '_' + ext,
                )
            }
        }
    }
    return name
}

function getTxtUrl(view: any) {
    const url = view.url
    fetch(url)
        .then((r) => r.blob())
        .then((blob) => {
            const reader = new FileReader()
            reader.readAsText(blob, 'utf-8')
            reader.onload = function () {
                const txt = reader.result as string
                view.txt = txt.length > 300? txt.slice(0, 300) + '…': txt
            }
        })
}

function hasCard() {
    let hasCard = false
    data.message.forEach((item: any) => {
        if (item.type === 'json' || item.type === 'xml') {
            hasCard = true
        }
    })
    return hasCard
}

function hasMarkdown() {
    let hasMarkdown = false
    data.message.forEach((item: any) => {
        if (item.type === 'markdown') {
            hasMarkdown = true
        }
    })
    return hasMarkdown
}

function sendPoke() {
    emit('sendPoke', data.sender.user_id)
}

async function showPock() {
    if (data.message_id ==
        chatStore.messageList[chatStore.messageList.length - 1].message_id &&
        (new Date().getTime() - getViewTime(data.time)) / 1000 < 5) {
        let windowInfo = null as {
            x: number
            y: number
            width: number
            height: number
        } | null
        if (backend.isDesktop()) {
            windowInfo = await backend.call('Onebot', 'win:getWindowInfo', true)
        }
        const message = document.getElementById('chat-' + data.message_id)
        let item = document.getElementById('app')
        if (backend.isDesktop()) {
            item = message?.getElementsByClassName('poke-hand')[0] as HTMLImageElement
        }
        nextTick(() => {
            pokeAnime(item, windowInfo)
        })
    }
}

function isSuperFaceMsg() {
    if (settingsStore.sysConfig.use_super_face === false) return false
    if (data.message.length !== 1) return false
    const seg = data.message.at(0)
    if (seg.type !== 'face') return
    return Emoji.allSuperList.has(Number(seg.id))
}

function getMdHTML(str: string, id: string) {
    const html = md.render(str)
    const div = document.createElement('div')
    div.innerHTML = html
    const imgs = div.getElementsByTagName('img')
    for(let i=0; i<imgs.length; i++) {
        const img = imgs[i]
        const alt = img.getAttribute('alt')
        if(alt) {
            const size = alt.split('#')
            if(size.length == 3) {
                img.style.width = size[1]
                img.style.height = size[2]
            }
        }
    }
    const links = div.getElementsByTagName('a')
    for(let i=0; i<links.length; i++) {
        const link = links[i]
        const href = link.getAttribute('href')
        if(href) {
            link.setAttribute('data-link', href)
            link.setAttribute('href', '')
            link.onclick = (e) => {
                e.preventDefault()
                openLink(href)
            }
        }
    }

    setTimeout(() => {
        const body = document.getElementById(id)
        if(body) {
            body.innerHTML = ''
            body.appendChild(div)
        }
    }, 500)

    return id
}

function sendPlay(info: MusicInfo) {
    addMusic(info, 'current', true)
}

function openMerge(){
    const seg = data.message[0]
    if (!seg.content) {
        new PopInfo().add(PopType.ERR, $t('合并转发解析失败'))
        return
    }

    const mergeData: MergeStackData = {
        messageList: [],
        imageList: [],
        placeCache: 0,
        forwardMsg: data
    }

    mergeData.messageList = seg.content
    const imgList = [] as {
        index: number
        message_id: string
        img_url: string
    }[]
    let index = 0
    mergeData.messageList.forEach((item) => {
        item.message.forEach((msg) => {
            if (msg.type == 'image') {
                imgList.push({
                    index: index,
                    message_id: item.message_id,
                    img_url: msg.url,
                })
                index++
            }
        })
    })
    mergeData.imageList = imgList

    chatStore.mergeMsgStack.push(mergeData)
}

function isFace(item: any) {
    if (item.asface) return true
    else if (item.subType == 7) return true
    else if (item.subType == 1) return true
    else if (item.sub_type == 7) return true
    else if (item.sub_type == 1) return true
    return false
}

//#endregion

//#region == 生命周期 ================================================================

onMounted(() => {
    isMe.value =
        Number(authStore.loginInfo.uin) ===
        Number(data.sender.user_id)
    if(globalMe) {
        isMe.value = globalMe == 'Y'
    }
    watch(
        () => chatStore.chatInfo.info.group_members.length,
        () => {
            senderInfo.value =
                chatStore.chatInfo.info.group_members.filter(
                    (item: any) => {
                        return item.user_id == data.sender.user_id
                    },
                )[0]
        },
    )
    senderInfo.value = chatStore.chatInfo.info.group_members.filter(
        (item: any) => {
            return item.user_id == data.sender.user_id
        },
    )[0]
    for (let i = 0; i < data.message.length; i++) {
        const item = data.message[i]
        if(item.type == 'text') {
            parseText(i)
        }
    }
    if (data._from_local_db && settingsStore.sysConfig.opt_no_auto_load_image !== true) {
        loadCachedImages()
    }
    if(isSuperFaceMsg()) {
        msgBodyClass.value += ' super-face'
    }
    if(type != 'body') {
        if(isMe.value && type != 'merge') {
            msgBodyClass.value += ' me'
        }
        if(settingsStore.sysConfig.opt_ind_message === true) {
            msgBodyClass.value += ' right'
        }
    }
})

//#endregion
</script>
<style>
    .dev-local-tag {
        display: inline-block;
        padding: 1px 7px !important;
        background: var(--color-card) !important;
        color: var(--color-font-2) !important;
    }
    .emoji-like {
        flex-direction: row;
        display: flex;
        width: 100%;
    }
    .emoji-like-body {
        display: flex;
        flex-direction: row;
        flex-wrap: wrap;
        max-width: 30%;
        margin-left: 50px;
        margin-top: 10px;
    }
    .emoji-like-body div {
        background: var(--color-card-1);
        border-radius: 7px;
        margin-right: 5px;
        padding: 5px 15px;
        margin-bottom: 5px;
    }
    .emoji-like-body img {
        width: 15px;
        height: 15px;
    }
    .emoji-like-body span {
        color: var(--color-font-2);
        margin-left: 10px;
        font-size: 0.8rem;
    }
    .emoji-like-body .emoji {
        width: 20px;
        height: 20px;
        font-size: 1rem;
        margin: 0;
    }
    .emoji-like-body div.me-send{
        background-color: var(--color-main);
    }
    .emoji-like-body div.me-send:hover {
        background: var(--color-font);
    }
    .emoji-like-body > div.me-send span {
        color: var(--color-font-r);
    }

    @media (min-width: 992px) {
        .emoji-like.me {
            flex-direction: row-reverse;
        }
        .emoji-like.me > div.emoji-like-body {
            flex-direction: row-reverse;
            margin-right: -5px;
        }
    }

    .link-view-bilibili {
        flex-direction: column;
        cursor: pointer;
        width: 100%;
    }
    .link-view-bilibili > div.user {
        display: flex;
        align-items: center;
        margin-bottom: 10px;
    }
    .link-view-bilibili > div.user > img {
        width: 20px;
        border-radius: 100%;
        border: 2px solid transparent;
        outline: 2px solid var(--color-card);
    }
    .link-view-bilibili > div.user > span {
        flex: 1;
        margin-left: 10px;
        margin-right: 40px;
    }
    .link-view-bilibili > div.user > a {
        color: var(--color-font-2);
        font-size: 0.8rem;
    }
    .link-view-bilibili > img {
        margin-bottom: 10px;
        max-width: 100% !important;
        max-height: 30vh !important;
        width: fit-content;
        object-fit: contain;
    }
    .link-view-bilibili > a {
        color: var(--color-font-2) !important;
        font-size: 0.8rem;
        max-height: 4rem;
        overflow-y: scroll;
    }
    .link-view-bilibili > a::-webkit-scrollbar {
        background: transparent;
    }
    .link-view-bilibili > div.data {
        display: flex;
        flex-direction: row;
        align-items: center;
        font-size: 0.8rem;
        margin-top: 10px;
        justify-content: space-around;
        opacity: 0.7;
    }

    .link-view-music163 {
        width: calc(100% + 60px);
        margin-right: -60px;
        display: flex;
    }
    .link-view-music163 div {
        display: flex;
        flex-direction: column;
        flex: 1;
    }
    .link-view-music163 img {
        width: 60px;
        height: 60px;
        border-radius: 7px;
        margin-left: 20px;
    }
    .link-view-music163 a {
        text-wrap: nowrap;
        font-weight: bold;
        margin: 0;
    }
    .link-view-music163 span {
        text-wrap: nowrap;
        font-size: 0.8rem;
        opacity: 0.7;
    }
    .link-view-music163 svg {
        --size: 20px;
        color: #545454;
        width: var(--size);
        height: var(--size);
        padding: calc(calc(60px - var(--size)) / 2);
        transform: translateX(-100%);
    }
    .link-view-music163 svg.light {
        color: #e5e5e5;
    }
</style>
