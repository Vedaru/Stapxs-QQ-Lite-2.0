/* eslint-disable max-len */
/**
 * 文件传输任务状态（下载 / 上传）。
 * 从 FileManager.vue 的模块脚本抽出，让面板组件可以按需异步加载，
 * 而任务状态的读写不再依赖组件本体进入主包。
 */
import { ref } from 'vue'
import { downloadFile } from '@renderer/function/utils/appUtil'

export type TaskStatus = 'pending' | 'downloading' | 'uploading' | 'completed' | 'failed' | 'cancelled'

export interface TransferTask {
    id: string
    fileName: string
    fileSize: number
    filePath: string
    url: string
    status: TaskStatus
    progress: number
    downloaded: number
    uploaded: number
    createdAt: number
    updatedAt: number
    error?: string
}

// 模块级别状态
export const downloadTasksState = ref<TransferTask[]>([])
export const uploadTasksState = ref<TransferTask[]>([])
const panelVisibleState = ref(false)

// 存储下载任务的取消回调
export const downloadCancelCallbacks = new Map<string, () => void>()

let taskCounter = 0
const generateTaskId = () => {
    taskCounter++
    return `task_${Date.now()}_${taskCounter}`
}

/**
 * 打开文件传输管理器面板
 */
export const openPanel = () => {
    panelVisibleState.value = true
}

/**
 * 关闭文件传输管理器面板
 */
export const closePanel = () => {
    panelVisibleState.value = false
}

/**
 * 获取面板显示状态
 */
export const panelVisible = panelVisibleState

export const addDownloadTask = (info: {
    fileName: string,
    fileSize: number,
    filePath: string,
    url: string,
    onProgress?: (progress: number) => void,
    onComplete?: () => void,
    onError?: (error: string) => void
}) => {
    const task: TransferTask = {
        id: generateTaskId(),
        fileName: info.fileName,
        fileSize: info.fileSize,
        filePath: info.filePath,
        url: info.url,
        status: 'downloading',
        progress: 0,
        downloaded: 0,
        uploaded: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
    }
    downloadTasksState.value.push(task)
    openPanel()

    // 处理进度回调
    const onprocess = (event: ProgressEvent & { [key: string]: any }) => {
        const index = downloadTasksState.value.findIndex(t => t.id === task.id)
        // 忽略已取消、已完成或不存在的任务
        if (index === -1 ||
            downloadTasksState.value[index].status === 'cancelled' ||
            downloadTasksState.value[index].status === 'completed') {
            return undefined
        }

        const loaded = event.loaded || 0
        const total = event.total || info.fileSize

        // 创建新对象以触发响应式更新
        const currentTask = { ...downloadTasksState.value[index] }
        currentTask.downloaded = loaded
        currentTask.fileSize = total
        currentTask.progress = total > 0 ? Math.round((loaded / total) * 100) : 0
        currentTask.updatedAt = Date.now()

        // 调用外部回调
        if (info.onProgress) {
            info.onProgress(currentTask.progress)
        }

        // 下载完成
        if (loaded >= total && total > 0) {
            currentTask.status = 'completed'
            currentTask.progress = 100
            currentTask.updatedAt = Date.now()
            downloadCancelCallbacks.delete(task.id)
            // 清理监听器
            cleanup()
            if (info.onComplete) {
                info.onComplete()
            }
        }

        // 替换数组中的对象以触发响应式更新
        downloadTasksState.value[index] = currentTask
        downloadTasksState.value = [...downloadTasksState.value]

        return undefined
    }

    // 处理取消回调
    const oncancel = (_: ProgressEvent & { [key: string]: any }) => {
        const currentTask = downloadTasksState.value.find(t => t.id === task.id)
        // 忽略已完成或已取消的任务
        if (currentTask && currentTask.status !== 'completed' && currentTask.status !== 'cancelled') {
            currentTask.status = 'cancelled'
            currentTask.updatedAt = Date.now()
            downloadCancelCallbacks.delete(task.id)
            // 清理监听器
            cleanup()
            if (info.onError) {
                info.onError('下载已取消')
            }
        }
        return undefined
    }

    // 存储取消回调以便后续调用
    downloadCancelCallbacks.set(task.id, () => {
        oncancel({} as ProgressEvent)
    })

    // 用于存储清理函数
    let cleanup: () => void = () => {}

    // 开始下载
    try {
        cleanup = downloadFile(info.url, info.fileName, onprocess, oncancel)
    } catch (e) {
        const currentTask = downloadTasksState.value.find(t => t.id === task.id)
        if (currentTask) {
            currentTask.status = 'failed'
            currentTask.error = String(e)
            currentTask.updatedAt = Date.now()
        }
        downloadCancelCallbacks.delete(task.id)
        if (info.onError) {
            info.onError(String(e))
        }
    }

    return task.id
}

export const addUploadTask = (info: {
    fileName: string,
    fileSize: number,
    // 执行上传的函数，接收 onProgress 回调
    execute: (onProgress: (loaded: number, total: number) => void) => void
}) => {
    const task: TransferTask = {
        id: generateTaskId(),
        fileName: info.fileName,
        fileSize: info.fileSize,
        filePath: '',
        url: '',
        status: 'uploading',
        progress: 0,
        downloaded: 0,
        uploaded: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
    }
    uploadTasksState.value.push(task)
    openPanel()

    // 存储回调供 completeUploadTask/failUploadTask 调用
    uploadCallbacks.set(task.id, {})

    // 执行上传
    const onProgress = (loaded: number, total: number) => {
        const index = uploadTasksState.value.findIndex(t => t.id === task.id)
        if (index === -1 || uploadTasksState.value[index].status === 'cancelled') {
            return
        }
        // 创建新对象以触发响应式更新
        const currentTask = { ...uploadTasksState.value[index] }
        currentTask.uploaded = loaded
        currentTask.fileSize = total
        currentTask.progress = total > 0 ? Math.round((loaded / total) * 100) : 0
        currentTask.updatedAt = Date.now()
        // 替换数组中的对象以触发响应式更新
        uploadTasksState.value[index] = currentTask
        uploadTasksState.value = [...uploadTasksState.value]
    }

    info.execute(onProgress)

    return task.id
}

// 存储上传任务的回调
const uploadCallbacks = new Map<string, Record<string, never>>()

/**
 * 标记上传任务完成（由外部调用，如 sendFileBack 回调）
 * @param taskId 任务ID
 */
export const completeUploadTask = (taskId: string) => {
    const index = uploadTasksState.value.findIndex(t => t.id === taskId)
    if (index !== -1 && uploadTasksState.value[index].status !== 'cancelled') {
        const task = { ...uploadTasksState.value[index] }
        task.status = 'completed'
        task.progress = 100
        task.updatedAt = Date.now()
        uploadTasksState.value[index] = task
        uploadTasksState.value = [...uploadTasksState.value]
        uploadCallbacks.delete(taskId)
    }
}

/**
 * 标记上传任务失败（由外部调用）
 * @param taskId 任务ID
 * @param error 错误信息
 */
export const failUploadTask = (taskId: string, error: string) => {
    const index = uploadTasksState.value.findIndex(t => t.id === taskId)
    if (index !== -1 && uploadTasksState.value[index].status !== 'cancelled') {
        const task = { ...uploadTasksState.value[index] }
        task.status = 'failed'
        task.error = error
        task.updatedAt = Date.now()
        uploadTasksState.value[index] = task
        uploadTasksState.value = [...uploadTasksState.value]
        uploadCallbacks.delete(taskId)
    }
}

/**
 * 取消上传任务（供外部调用）
 * @param taskId 任务ID
 */
export const cancelUploadTask = (taskId: string) => {
    const index = uploadTasksState.value.findIndex(t => t.id === taskId)
    if (index !== -1) {
        const task = { ...uploadTasksState.value[index] }
        task.status = 'cancelled'
        task.updatedAt = Date.now()
        uploadTasksState.value[index] = task
        uploadTasksState.value = [...uploadTasksState.value]
        setTimeout(() => removeUploadTask(taskId), 1000)
    }
}

export const getDownloadTasks = () => downloadTasksState.value
export const getUploadTasks = () => uploadTasksState.value

export const removeDownloadTask = (taskId: string) => {
    downloadCancelCallbacks.delete(taskId)
    const index = downloadTasksState.value.findIndex(t => t.id === taskId)
    if (index !== -1) {
        downloadTasksState.value.splice(index, 1)
    }
}

export const removeUploadTask = (taskId: string) => {
    const index = uploadTasksState.value.findIndex(t => t.id === taskId)
    if (index !== -1) {
        uploadTasksState.value.splice(index, 1)
    }
}
