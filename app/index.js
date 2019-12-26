const os = require('os')
const { sep, join } = require('path')

global.evaSpace = {
  config: {
    ...require('./config.json')
  },
  ...require('./global.js'),
  evaWorkHome: `${os.homedir()}${sep}.eva${sep}`
}

const electron = require('electron')
const utils = require('./utils/index.js')
const { initEva } = require('./utils/initialize.js')
const PluginLoader = require('./loaders/PluginLoader/index.js')
const { isMac, isWindows, PAS, saveFocus, logger, restoreFocus } = require('./utils/index.js')
const { app, globalShortcut, ipcMain, Tray, clipboard } = electron
const { createEvaWindow, createMainWindow } = require('./loaders/WindowLoader/index.js')

logger.trace('开始初始化App')
initEva()

// 插件加载器
const plugins = PluginLoader(utils)
const commonPlugins = plugins.filter(plugin => plugin.quick === '*')

let evaWindow
let mainWindow
let tray
let queryResult = []

function registerGlobalShortcut () {
  logger.trace('注册全局快捷键')
  let registerSuccess = globalShortcut.register('CommandOrControl+Shift+M', () => switchWindowShown())
  if (!registerSuccess) logger.error('注册快捷键CommandOrControl+Shift+M失败')
  registerSuccess = globalShortcut.register('CommandOrControl+\\', () => switchWindowShown())
  if (!registerSuccess) logger.error('注册快捷键CommandOrControl+\\失败')
  registerSuccess = globalShortcut.register('CommandOrControl+Shift+Alt+M', () => evaWindow.openDevTools())
  if (!registerSuccess) logger.error('注册快捷键CommandOrControl+Shift+Alt+M失败')
  registerSuccess = globalShortcut.register('CommandOrControl+Shift+Alt+R', () => restart())
  if (!registerSuccess) logger.error('注册快捷键CommandOrControl+Shift+Alt+R失败')
  registerSuccess = globalShortcut.register('CommandOrControl+Alt+P', () => app.quit())
  if (!registerSuccess) logger.error('注册快捷键CommandOrControl+Alt+P失败')
}

app.on('ready', () => {
  logger.trace('App已经就绪')
  try {
    logger.trace('创建隐藏的主窗口')
    mainWindow = createMainWindow()
  } catch (e) {
    logger.error(e)
  }
  logger.trace('创建Eva窗口')
  evaWindow = createEvaWindow(evaSpace.config.width, evaSpace.config.height, evaSpace.config.opacity)
  tray = new Tray(PAS(join(evaSpace.ROOT_DIR, './logo-1024-16x16@3x.png'), './icon.ico'))
  tray.setToolTip('Eva')

  evaWindow.on('blur', () => hideWindow())

  registerGlobalShortcut()
  ipcMain.on('box-input-esc', () => hideWindow())
  ipcMain.on('hide-main-window', () => hideWindow())
  ipcMain.on('box-input', boxInput)
  ipcMain.on('box-blur', () => hideWindow())
  ipcMain.on('action', action)
  ipcMain.on('restore-box-height', () => changeBoxNum(0))
  logger.info('欢迎使用Eva!')
  notice({
    title: 'Eva',
    body: '你好人类，我将给予你帮助！'
  })
})

function changeBoxNum (num) {
  if (num > 5) num = 5
  const h = 50
  evaWindow.setSize(evaSpace.config.width, +evaSpace.config.height + h * num)
}

function action (event, index) {
  logger.info(event)
  if (queryResult.length <= 0) return
  new Promise((resolve) => {
    queryResult[index].action()
    resolve()
  }).then(() => {
    event.sender.send('action-exec-success')
  }).catch(reason => {
    logger.error(reason)
  })
}

async function executeCommonPlugin (input) {
  const queryPromises = commonPlugins.map(plugin => plugin.query({
    query: input,
    utils
  }))
  let queryResult = []
  const resultArr = await Promise.all(queryPromises)
  for (const result of resultArr) {
    queryResult = queryResult.concat(result)
  }
  return queryResult
}

function findSuitablePlugin (quickName) {
  return plugins.find(plugin => plugin.quick === quickName)
}

async function executeExactPlugin (suitablePlugin, pluginQuery) {
  if (!pluginQuery) return []
  return await suitablePlugin.query({
    query: pluginQuery,
    clipboard,
    utils: {
      ...utils,
      notice
    }
  })
}

let lastedInput

function boxInput (event, input) {
  lastedInput = input
  if (!input) return clearQueryResult(event)

  // 如果不包含空格则执行通用插件（*插件）
  const blankIndex = input.indexOf(' ')
  if (blankIndex === -1) {
    return returnValue(event, input, executeCommonPlugin(input))
  }

  const [quickName, ...values] = input.split(' ')
  // 匹配插件
  const suitablePlugin = findSuitablePlugin(quickName)
  // 未匹配到
  if (!suitablePlugin) {
    return returnValue(event, input, executeCommonPlugin(input))
  }
  // 处理执行匹配的插件
  const pluginQuery = values.join(' ')
  return returnValue(event, input, executeExactPlugin(suitablePlugin, pluginQuery))
}

function returnValue (event, input, resultPromise) {
  resultPromise
    .then(result => {
      // 如果本次回调对应的input不是最新输入，则忽略
      if (input !== lastedInput) return clearQueryResult(event)

      if (result.length) clearQueryResult(event)
      changeBoxNum(result.length)
      event.sender.send('query-result', result)
      // 在主线程保存插件结果，用于执行action，因为基于json的ipc通讯不可序列化function
      queryResult = result
    })
    .catch(reason => logger.error(reason))
}

function clearQueryResult (event) {
  event.sender.send('clear-query-result')
  changeBoxNum(0)
}

let appIsVisible = false

function hideWindow () {
  evaWindow.hide()
  if (isWindows) restoreFocus()
  if (isMac) app.hide()
  appIsVisible = false
}

function showWindow () {
  evaWindow.show()
  if (isWindows) saveFocus()
  if (isMac) app.show()
  appIsVisible = true
}

function switchWindowShown () {
  appIsVisible ? hideWindow() : showWindow()
}

function restart () {
  app.relaunch({ args: process.argv.slice(1).concat(['--relaunch']) })
  app.exit(0)
}

/**
 * titleString - 通知的标题, 将在通知窗口的顶部显示.
 * subtitleString (可选) 通知的副标题, 显示在标题下面。 macOS
 * bodyString 通知的正文文本, 将显示在标题或副标题下面.
 * silentBoolean (可选) 在显示通知时是否发出系统提示音。
 * icon(String | NativeImage ) (可选) 用于在该通知上显示的图标。
 * hasReplyBoolean (可选) 是否在通知中添加一个答复选项。 macOS
 * replyPlaceholderString (可选) 答复输入框中的占位符。 macOS
 * soundString (可选) 显示通知时播放的声音文件的名称。 macOS
 * actions NotificationAction[] (可选) macOS - 要添加到通知中的操作 请阅读 NotificationAction文档来了解可用的操作和限制。
 * closeButtonText String (可选) macOS - 自定义的警告框关闭按钮文字。如果该字符串为空，那么将使用本地化的默认文本。
 * @param option
 * @returns {Electron.Notification}
 */
function notice (option) {
  let notice = new electron.Notification(option)
  notice.show()
  return notice
}
