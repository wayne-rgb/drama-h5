# Docker 部署

## 本地一体服务

根目录 `compose.yaml` 从 `server/Dockerfile` 构建本地服务，同时构建并托管 Web 页面，默认访问 `http://localhost:8788`。数据库保存在命名卷 `local-data`，更新镜像保留数据。旧 8787 入口已移除。

```sh
docker compose up -d --build
docker compose logs --tail=100
docker compose down
```

环境变量 `HG_BIND_IP`、`HG_PORT` 的示例见根目录 `.env.example`。默认仅绑定本机，局域网访问可修改绑定地址。Node 不自动加载 `.env`；Compose 按其环境文件规则加载。不要使用 `down -v` 删除保存资料的卷。

`.dockerignore` 排除本地密钥、数据库、依赖和构建产物。Docker 和 Linux 宿主验收以 [交付验证](DELIVERY_VERIFICATION.md) 为准。
