# 项目架构

Web / Windows 共用界面和 Node 本地后端核心，各自保存独立 SQLite 与配置。Windows 通过 Electron 管理动态本机端口，用稳定自定义协议加载页面，退出只停止自己启动的进程。

server/ 是唯一的本地 Node 后端入口，通过 shared/content-provider.mjs 调用 shared/content-core/hongguo.js 获取内容，提供签名、解密和 Range 播放接口。TV 使用相同源文件及 QuickJS JNI，网络、加密与媒体字节处理使用原生实现，不依赖 Node 或其他设备。旧 8787 启动入口已移除；shared/content-http.mjs 保留兼容协议处理器和既有媒体安全回归测试，不启动独立服务。

本地 SQLite 保存收藏、历史、搜索、推荐信号、默认画质和倍速。Web 资料按当前账户或游客会话隔离，TV 资料保存在应用私有目录。接口、数据目录、产物和部署见 [LOCAL_SERVICES.md](LOCAL_SERVICES.md)。
