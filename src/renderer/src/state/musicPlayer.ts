/* eslint-disable max-len */
/**
 * 全局音乐播放状态。
 * 从 MusicPlayer.vue 的模块脚本抽出，让播放器面板可以按需异步加载，
 * 而播放列表状态的读写不再依赖组件本体进入主包。
 */
import { ref } from 'vue'

export type LyricLine = { [key: number]: string }

export interface MusicInfo {
    title: string,                                  // 标题
    author: string[],                               // 作者
    url: string,                                    // 音乐链接
    type: 'default' | 'music163',                   // 音乐类型（用于特殊功能）
    cover: string,                                  // 封面链接
    free?: boolean                                  // 试听标识
    time?: number                                   // 音频时长
    data?: any                                      // 额外数据（如歌曲ID等）
    lyric?: LyricLine[]                              // 歌词（可选）
}

export const emitRef = ref(undefined as any)
export const resetController = ref(() => {})

// 打开播放器面板的请求标记：面板组件按需挂载，未挂载时 emit 会丢，
// 所以同时在状态层放一个标记，由 App.vue 监听后真正打开面板
export const openPanelRequest = ref(false)

export const musicListState = ref<MusicInfo[]>([])
export const currentIndexState = ref(0)
export const readyToPlayState = ref(false)
export const audoState = ref(null as HTMLAudioElement | null)
export const nowLyricState = ref(undefined as { index: number, text: string } | undefined)

export const lyricTime = (line: LyricLine) => parseFloat(Object.keys(line)[0])
export const lyricText = (line: LyricLine) => Object.values(line)[0]

export const parseLyric = (lyricText: string) => {
    return lyricText
        .split('\n')
        .flatMap((line: string) => {
            const timeMatches = [...line.matchAll(/\[(\d{1,2}):(\d{1,2}(?:\.\d+)?)\]/g)]
            if (timeMatches.length === 0) {
                return []
            }

            const text = line.replace(/\[[^\]]+\]/g, '').trim()
            if (!text) {
                return []
            }

            return timeMatches.map(match => {
                const time = parseFloat(match[1]) * 60 + parseFloat(match[2])
                return {
                    [time]: text,
                }
            })
        })
        .sort((a, b) => lyricTime(a) - lyricTime(b))
}

export const mergeLyric = (originalLyric: LyricLine[], translatedLyric: LyricLine[]) => {
    const merged = new Map<number, string>()

    originalLyric.forEach(line => {
        merged.set(lyricTime(line), lyricText(line))
    })
    translatedLyric.forEach(line => {
        merged.set(lyricTime(line), lyricText(line))
    })

    return [...merged.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([time, text]) => ({ [time]: text }))
}

export const findLyricIndex = (lyrics: LyricLine[], currentTime: number) => {
    let left = 0
    let right = lyrics.length - 1
    let ans = -1

    while (left <= right) {
        const mid = Math.floor((left + right) / 2)
        const midTime = lyricTime(lyrics[mid])
        if (midTime <= currentTime) {
            ans = mid
            left = mid + 1
        } else {
            right = mid - 1
        }
    }

    return ans
}

export const getCurrentMusic = () => {
    if (currentIndexState.value < 0 || currentIndexState.value >= musicListState.value.length) {
        return null
    }

    return musicListState.value[currentIndexState.value]
}

/**
 * 注册音乐播放器的设置项。
 * 原本写在 MusicPlayer.vue 的 onMounted 里，但播放器面板现在是懒挂载的
 * （App.vue 里 v-if="musicPlayerMounted"，只有开始播放音乐后才会挂载），
 * 没播放过音乐的会话就再也不会挂载，设置卡片也就永远不出现。
 * 因此挪到状态层，由 App.vue 在配置加载完成后调用一次。
 *
 * 这里用动态 import 而不是顶层 import：option.ts 的静态依赖环里已经有
 * App.vue / main.ts 一大坨（见 App.vue 的 initApp），再加一条静态边会把
 * 本模块一并卷进那个环，徒增初始化顺序风险，而注册本来就发生在初始化
 * 之后，按需加载反而更贴合。
 */
export const registerMusicPlayerOptions = async () => {
    const { registerExtraOptionCard, registerExtraOptionItem } =
        await import('@renderer/function/option')
    registerExtraOptionCard({
        id: 'music-player',
        title: '音乐播放器设置',
    })
    registerExtraOptionItem('music-player', {
        id: 'glabal_lyric',
        icon: 'book',
        label: '显示歌词横幅',
        description: '在应用顶部显示当前播放音乐的歌词',
        type: 'switch',
        optionKey: 'glabal_lyric',
        defaultValue: true,
    })
    registerExtraOptionItem('music-player', {
        id: 'original_lyrics',
        icon: 'font',
        label: '显示原歌词',
        description: '显示原文歌词而非翻译歌词（需要重新播放）',
        type: 'switch',
        optionKey: 'original_lyrics',
        defaultValue: false,
    })
}

export const addMusic = (info: MusicInfo | null | undefined, type: 'top' | 'bottom' | 'current' = 'bottom', open: boolean = false) => {
    if (!info) {
        return
    }
    // 筛选掉同 title 的
    musicListState.value = musicListState.value.filter(item => {
        return item.title !== info.title
    })
    if (type === 'top') {
        musicListState.value.unshift(info)
        currentIndexState.value++
    } else if (type === 'current') {
        if(audoState.value?.played) {
            audoState.value.pause()
            musicListState.value.unshift(info)
            currentIndexState.value = 0
        } else {
            musicListState.value.unshift(info)
        }
        nowLyricState.value = undefined
        emitRef.value?.('update-lyric', '')
        readyToPlayState.value = true
    } else {
        musicListState.value.push(info)
    }

    if (open) {
        openPanelRequest.value = true
        emitRef.value?.('open-panel', true)
    }
}
