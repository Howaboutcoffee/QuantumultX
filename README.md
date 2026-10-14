## 本 fork：流媒体检测修复

本 fork 保留上游来源，只维护本次修复的综合检测入口 `Scripts/streaming-ui-check.js`。

### 导入 Quantumult X

在 `[task_local]` 添加下面一行；若已有同名任务，替换旧行，避免重复：

```ini
event-interaction https://raw.githubusercontent.com/Howaboutcoffee/QuantumultX/master/Scripts/streaming-ui-check.js, tag=流媒体-解锁查询, img-url=checkmark.seal.system, enabled=true
```

也可导入 [UI 脚本合集](https://raw.githubusercontent.com/Howaboutcoffee/QuantumultX/master/Scripts/UI-Action.json)，使用其中的「流媒体-解锁查询」。其他独立查询/切换脚本仍沿用上游，未包含本次修复。

更新脚本缓存后，在 Quantumult X 首页长按待测节点或策略组，选择该任务。传入策略决定测试出口；从其他入口运行且没有策略参数时，脚本会提示重新选择，不会默认测试另一条线路。策略组在测试期间发生自动切换时，各平台结果可能来自不同节点；需要固定出口对比时，请直接选择具体节点。

### 界面

保留上游的居中排版、服务顺序、国旗/状态图标、虚线分隔和红色节点名称。结果使用简短且准确的「样本可用」「地区支持」「网页可访问」等描述；详细判定保留在 HTML 行标题中。Disney 设备创建接口兼容 HTTP 200/201，并继续校验地区信息。

### 判定与限制

- Netflix：检查两个非自制片样本的实际可用字段，不再把 HTTP 200 当成完整解锁；样本均不可用也不能直接证明「仅自制」。
- Disney+：通过匿名设备、授权及地区接口读取明确支持字段。验证页、限流、授权错误、字段缺失均显示无法判断，不冒充地区限制。
- ChatGPT：使用 `chatgpt.com`，区分网页可访问、验证要求和明确地区限制；出口国家只作展示，不代表能登录或对话。
- YouTube、DAZN、Paramount+、Discovery+：只报告实际获得的网页/地区证据，不承诺播放或账号权限。
- 请求最多等待 7 秒，整项任务最多等待 25 秒；单个平台异常不覆盖其他结果，任务只结束一次。
- 保持 TLS 证书校验。不记录响应正文、访问令牌或客户端节点信息到日志，不向额外的统计服务上传检测数据。测试会直接请求对应平台，平台会看到测试出口。
- Disney 浏览器客户端标识来自上游公开脚本；运行时获取的匿名设备令牌仅用于当前测试，不保存为文件。

自动测试使用虚构响应、虚构策略名称，不需要订阅、账号或服务器凭据。没有在 iOS Quantumult X 中进行设备端验收；实际播放、登录和对话仍需在对应应用中确认。平台接口改变后可能显示「无法判断」，这比误报解锁更可靠。

### 本地验证

无需安装第三方依赖，使用 Node.js 18 或更新版本：

```sh
node --check Scripts/streaming-ui-check.js
node --test tests/streaming-ui-check.test.cjs
```

---

# QuantumultX
> > [!TIP]
> >
> > <u>**纯自用，无规则，不保证维护，不保证更新**</u>
> >
> > 2026-05-18



仅以下项目前还更新维护：    

1⃣️ Quantumult X 资源解析器:   


https://github.com/KOP-XIAO/QuantumultX/blob/master/Scripts/resource-parser.js



有bug请反馈 [@ShawnKOP_Parser_Bot](https://t.me/Shawn_Parser_Bot) 

更新请关注 tg 频道 https://t.me/QuanX_API



如觉得有帮助，可以请喝杯咖啡:



<img src="https://tva1.sinaimg.cn/large/007S8ZIlgy1geiniiv2onj30u00u0wgi.jpg" alt="IMG_5957" style="zoom:23%;" />

