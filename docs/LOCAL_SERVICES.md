# 独立本地服务

Web、Windows 桌面和 Android TV 都可独立获取内容和播放。Web 资料按当前账户或游客会话保存在服务端 SQLite；Windows 桌面使用自己的本地服务；TV 将收藏、历史、搜索和偏好保存在应用私有 SQLite。

## 一体包

产物目录为 `outputs/bundles`。

| 产物 | 启动 |
| --- | --- |
| `hongguotv-web-win-x64.zip` | 解压后双击 `start.cmd`，停止使用 `stop.cmd` |
| `hongguotv-web-linux-x64.tar.gz`／`linux-arm64` | 解压后 `sh start.sh`，停止使用 `sh stop.sh` |
| `hongguotv-web-darwin-x64.tar.gz`／`darwin-arm64` | 解压后 `sh start.sh`，停止使用 `sh stop.sh` |
| `hongguotv-desktop-win-x64.zip` | 解压后启动 `红果短剧.exe`，关闭程序同时关闭内置后端 |

Web 包内置 Node 22 和运行依赖，不调用系统 Node/npm；默认监听 8788。Windows 需 Windows 10+，Linux 需 glibc 2.28+／内核 4.18+，macOS 最低版本为 11。Linux 不包含 Alpine/musl 包。

Web 服务数据位于用户资料目录：Windows `%APPDATA%\HongguoTV\web-service`，Linux `${XDG_DATA_HOME:-~/.local/share}/HongguoTV/web-service`，macOS `~/Library/Application Support/HongguoTV/web-service`。`HG_DATA_DIR` 可指定其他位置，`HG_PORT` 可指定端口。升级替换程序目录不会覆盖用户数据库。

Windows 桌面数据位于 Electron 用户资料目录的 `local-service` 子目录。内置后端只监听本机动态端口。TV 数据位于应用私有 SQLite，保留 Android 5.1.1 支持。

## 资料接口与迁移

| 接口 | 用途 |
| --- | --- |
| `GET /api/library` | 读取当前账户或游客的资料 |
| `POST /api/library/operations` | 幂等写入收藏、历史、搜索、偏好和推荐信号 |
| `POST /api/library/import` | 幂等迁移旧资料 |

历史页面按最近观看排列，每部剧一张续播卡。Web 和电脑保留删除与清空确认；TV 仅查看和续播。搜索历史最多显示最近十条。

已有后端目录可迁移到新的独立数据目录：

```sh
node scripts/migrate-library.mjs --from <旧数据目录> --to <新数据目录>
```

迁移前停止旧服务。迁移保留资料和删除标记，不删除源目录，重复执行不会重复写入。

构建一体包：`node scripts/build-bundles.mjs`，可用 `--platforms=win-x64` 单独构建。Node 下载会校验官方 SHA256，包内保留运行环境与项目许可证。
