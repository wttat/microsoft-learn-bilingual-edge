# Learn 官方中英对照

Microsoft Edge 插件，并排阅读 Microsoft Learn 官方中英文正文，支持双向同步滚动和左右交换。默认左中文、右英文。

直接读取官方版本，不翻译、不使用 AI，无需构建或 API 密钥。

## 安装

1. 从 [Releases](https://github.com/wttat/microsoft-learn-bilingual-edge/releases/latest) 下载插件 ZIP 并解压，也可直接克隆源码。
2. 打开 `edge://extensions`，开启“开发人员模式”，点击“加载解压缩的扩展”，选择**包含 `manifest.json` 的目录**。
3. 打开或刷新 [Learn 文章](https://learn.microsoft.com/zh-cn/azure/storage/common/storage-account-overview)，自动显示对照。

**更新：**替换已加载目录中的文件，在扩展管理页点“重新加载”，再刷新网页。只启用一个副本；工具栏的“重新读取”不会更新插件代码。

## 使用

| 操作 | 作用 |
| --- | --- |
| 上一页／下一页 | 按官方单元顺序或前后页链接切换，保持对照模式；首尾或没有导航时禁用。 |
| 同步滚动 | 默认开启，滚动任一栏，另一栏跟随；可关闭。 |
| 交换中英位置 | 交换左右两栏，保留阅读位置。 |
| 自动打开 | 控制进入文章时是否自动展开。 |
| 打开官方原文 | 在新标签页打开对应语言页面。 |
| 重新读取 | 刷新正文或重试失败请求。 |
| 收起 · 返回原页 | 右下角悬浮按钮，恢复原页及滚动位置；也可按 Esc。 |

收起后，点击原页右下角“中英对照”或扩展图标重新打开。同步、自动打开和左右顺序设置保存在本机。

## 限制与隐私

- 支持常见 Learn 文档、.NET 参考文章和培训单元，不支持首页、课程目录、搜索和交互式练习。
- 只展示已存在的官方语言版本，缺失或回退时会提示。章节不一致时只能近似同步。
- 遇到重定向，先打开官方原文到最终地址，再对照。外站图片和交互组件请在原页查看。

仅申请 Learn 站点访问和本机存储权限；不执行导入页面的脚本，无遥测。

## 开发

源码测试需要 Node.js 22+，无第三方依赖：

```powershell
node --test tests\core.test.cjs tests\background.test.cjs
node --test tests\browser.test.cjs tests\training.test.cjs tests\navigation.test.cjs
```

浏览器测试需要 Edge 和网络，使用独立临时配置。非标准安装路径可通过 `EDGE_PATH` 指定。
