> 当前资料接口改为本地 /api/library 与可选远程 /api/sync；详见 [本地服务与远程同步](../docs/LOCAL_REMOTE_SERVICES.md)。旧 /api/history 保留兼容，来源分类不再用于页面。内容直接调用内置引擎，不需要固定上游。

# 红果短剧全能 Bridge 服务端 API 规范文档 (v2.5 全量版)

本服务端专为 **Windows 桌面端及 Web 前端** 设计，深度集成 **红果官方网站 (hongguoduanju.com)** 与 **底层内容解密服务**，包含以下核心业务模块：
1. **🏠 官方首页板块 (`/api/banners`, `/api/sections`)**：大轮播 Banner 池与首页专区流。
2. **🎭 官方分类板块 (`/api/category/*`)**：按类型读取官方实际题材（目前真人剧 24 种、漫剧／AI剧各 8 种）及分页。
3. ** 官方热播榜单 (`/api/rank/*`, `/api/ranks`)**：官方四大热播排行榜（Top 100 分页及首页前 9 名聚合）。
4. **🌟 推荐体系独立模块 (`/api/recommend`, `/api/series/:id/related`)**：全库算法推荐流与单剧相关/猜你喜欢。
5. **🔍 全库搜索板块 (`/api/search`)**：关键词模糊搜索与即时联想。
6. ** 详情与多清晰度播放 (`/api/series/:id`, `/api/episodes/:id/*`)**：官方真实多清晰度解析、实时 AES-128 解密与 HTTP Range 流分发。

---

## 目录
- [通用规范与鉴权](#通用规范与鉴权)
- [全量接口列表速览](#全量接口列表速览)
- [第一部分：首页板块 (Home)](#第一部分首页板块-home)
  - [`GET /api/banners` - 官方首页大轮播 Banner](#1-get-apibanners---官方首页大轮播-banner)
  - [`GET /api/sections` - 官方首页推荐四大专区](#2-get-apisections---官方首页推荐四大专区)
- [第二部分：分类板块 (Category)](#第二部分分类板块-category)
  - [`GET /api/category/tags` - 分类题材标签列表](#3-get-apicategorytags---分类题材标签列表)
  - [`GET /api/category/list` - 分类短剧列表 (支持类型/题材/分页)](#4-get-apicategorylist---分类短剧列表-支持类型题材分页)
- [第三部分：榜单板块 (Rank)](#第三部分榜单板块-rank)
  - [`GET /api/rank/types` - 官方四大排行榜类别池](#5-get-apiranktypes---官方四大排行榜类别池)
  - [`GET /api/rank/list` - 官方四大排行榜分页列表 (Top 100)](#6-get-apiranklist---官方四大排行榜分页列表-top-100)
  - [`GET /api/ranks` - 首页排行榜模块聚合数据 (前 9 名预览)](#7-get-apiranks---首页排行榜模块聚合数据-前-9-名预览)
- [第四部分：短剧推荐体系 (Recommendations) ★独立模块★](#第四部分短剧推荐体系-recommendations)
  - [`GET /api/recommend` - 全库算法推荐流 / 首页瀑布流](#8-get-apirecommend---全库算法推荐流--首页瀑布流)
  - [`GET /api/series/:id/related` - 单剧同类相关推荐 / 猜你喜欢](#9-get-apiseriesidrelated---单剧同类相关推荐--猜你喜欢)
- [第五部分：片库搜索 (Search)](#第五部分片库搜索-search)
  - [`GET /api/search` - 全库关键词搜索](#10-get-apisearch---全库关键词搜索)
- [第六部分：详情与媒体流 (Player & Stream)](#第六部分详情与媒体流-player--stream)
  - [`GET /api/series/:id` - 短剧详情与全集列表](#11-get-apiseriesid---短剧详情与全集列表)
  - [`GET /api/episodes/:id/qualities` - 官方真实多清晰度画质列表](#12-get-apiepisodesidqualities---官方视频实际拥有多清晰度画质列表)
  - [`GET /api/episodes/:id/play` - 单集播放解析](#13-get-apiepisodesidplay---单集播放解析)
  - [`GET /api/episodes/:id/stream` - 标准 MP4 视频媒体流代理](#14-get-apiepisodesidstream---标准-mp4-视频媒体流)

---

## 通用规范与鉴权

- **基础 URL (本地开发)**: `http://localhost:8788`
- **基础 URL (局域网部署)**: `http://<服务器IP>:8788`
- **跨域支持**: 公开内容接口允许跨域；账号操作通过 `APP_ORIGIN` 指定的站点与安全 Cookie 进行，开发时使用同源代理。
- **数据格式**: 标准 `UTF-8` 编码的 `application/json`。

---

## 全量接口列表速览

### 账号与会员接口

账号数据保存在 `accounts.sqlite`。已登录账号的追剧、历史、偏好与推荐分别使用独立资料库；读取和写入 `/api/library`、`/api/history`、`/api/recommend` 时必须携带与会话一致的 `X-Library-Owner`（账号 ID）。游客保留原本机／家庭资料，登录不会自动将游客资料导入个人账号。切换账号时旧队列保持原归属，过期会话或归属不符返回 `409`。

| 请求 | 接口 | 内容 |
| :--- | :--- | :--- |
| GET | `/api/account/session` | 当前用户、会员状态、可用服务、套餐和站点地址；不返回密码或会话令牌 |
| POST | `/api/auth/register` | 邮箱、昵称、密码注册；密码12至256个字符，服务端哈希保存 |
| POST | `/api/auth/login` | 邮箱密码登录，设置30天HttpOnly会话Cookie |
| POST | `/api/auth/logout` | 撤销当前会话并清理Cookie |
| POST | `/api/account/profile` | 修改昵称与头像；头像为1MB以内JPEG、PNG、WebP的Base64数据 |
| GET | `/api/account/avatar` | 当前账号的私有头像 |
| POST | `/api/auth/recover`、`/api/auth/reset` | 发送重置邮件、使用一次性令牌设置新密码并撤销旧会话 |
| POST | `/api/auth/verification`、`/api/auth/verify` | 发送验证邮件、使用一次性令牌确认邮箱 |
| GET | `/api/auth/google/start`、`/api/auth/google/callback` | Google授权码登录，校验状态、PKCE、ID令牌和nonce；`link=1`用于登录后的明确绑定 |
| POST | `/api/billing/checkout` | 按`planId`建立托管订阅结算；套餐金额由服务端确定 |
| POST | `/api/billing/portal` | 打开当前账号的订阅管理门户 |
| POST | `/api/billing/confirm` | 校验付款返回的结算记录归属与付款状态 |
| POST | `/api/billing/webhook` | 校验支付签名后更新订阅，拒绝伪造通知，重复通知不会重复生效 |

套餐为月付USD 29.99（`monthly`）与年付USD 199.99（`annual`）。VIP取决于真实订阅状态和有效期；取消续费但仍有效的会员保留权益，过期、取消或未付款状态不会显示为有效VIP。前端回跳地址或客户端提交的`membership`字段不能开通会员。

通过[环境变量示例](../.env.example)配置站点、Google与SMTP。支付默认关闭；当前提供可选Stripe适配器，配置后才启用托管结算、签名回调与客户门户。未配置的能力返回`503`，不会生成假邮件或假订单。Google与支付尚未配置时，不代表相关外部流程已验证。

接入接口参考[Google授权码流程](https://developers.google.com/identity/protocols/oauth2/web-server)、[Google ID令牌验证](https://developers.google.com/identity/sign-in/web/backend-auth)、[Stripe托管结算](https://docs.stripe.com/api/checkout/sessions/create)与[订阅数据结构](https://docs.stripe.com/api/subscriptions/object)。

| 业务板块 | 请求方式 | 接口路径 | 核心功能 |
| :--- | :--- | :--- | :--- |
| **首页** | `GET` | `/api/banners` | 官方超清大轮播横屏 Banner（含艺术字与背景） |
| **首页** | `GET` | `/api/sections` | 官方首页推荐四大专区（全部、真人剧、漫剧、AI剧） |
| **分类** | `GET` | `/api/category/tags` | 获取 24 种官方题材标签（爱情、逆袭、都市、古装等） |
| **分类** | `GET` | `/api/category/list` | 组合筛选短剧（可指定真人剧/漫剧/AI剧、题材 slug 及页码） |
| **榜单** | `GET` | `/api/rank/types` | 获取四大官方榜单类型元数据 |
| **榜单** | `GET` | `/api/rank/list` | 官方四大榜单分页列表（前 100 名完整排位、热度指数） |
| **榜单** | `GET` | `/api/ranks` | 首页四大排行榜横向卡片聚合（前 9 名快速预览） |
| **🌟推荐**| `GET` | `/api/recommend` | **全库个性化算法推荐流（瀑布流 / 猜你喜欢，支持分页）** |
| **🌟推荐**| `GET` | `/api/series/:id/related` | **单剧同类题材智能关联推荐（播放页“看了又看”）** |
| **搜索** | `GET` | `/api/search` | 全库短剧关键词检索 |
| **详情** | `GET` | `/api/series/:id` | 获取单部短剧元数据与所有选集清单 |
| **画质** | `GET` | `/api/episodes/:id/qualities` | **官方实际拥有全量清晰度列表（1080P/720P/540P/480P/360P）** |
| **解析** | `GET` | `/api/episodes/:id/play`| 解析单集视频播放直链与参数 |
| **播放** | `GET` | `/api/episodes/:id/stream` | **标准 MP4 媒体流**（实时 AES-128-CTR 解密，支持 HTTP Range） |

---


## 第一部分：首页板块 (Home)

### 1. `GET /api/banners` - 官方首页大轮播 Banner
- **功能**: 对应官方首页顶部横版大屏推荐。
- **响应示例**:
  ```json
  {
    "banners": [
      {
        "id": "7503745441910017049",
        "title": "宴律，你的白月光回国了",
        "cover": "https://.../cover.png",
        "backgroundCover": "https://.../bg_pc.png",
        "titleImage": "https://.../title_pc.png",
        "description": "七年前，顾星晚捅伤亲生父亲入狱...",
        "tags": "都市爱情/都市/破镜重圆/暗恋成真/白月光"
      }
    ]
  }
  ```

### 2. `GET /api/sections` - 官方首页专区列表
- **功能**: 获取官方首页预设的四大专区（包含对应分类的推荐剧集清单与排位）。
- **响应示例**:
  ```json
  {
    "sections": [
      {
        "type": "all",
        "name": "热播短剧",
        "items": [
          { "id": "7691228619774905368", "title": "聚宝仙盆之杂灵根才是真BOSS第十三季", "badge": "全222集", "cover": "...", "tags": "热播短剧 · 排名第1" }
        ]
      }
    ]
  }
  ```

### 3. `GET /api/home` - 首页推荐流
- **功能**: 首页精选短剧瀑布流。
- **参数**: `page` (可选，默认 1)

---

## 第二部分：分类板块 (Category)

对应官方页面：`https://hongguoduanju.com/category/real-drama`

### 3. `GET /api/category/tags` - 分类题材标签列表
- **功能**: 获取红果官方完整的 24 种细分题材筛选器。
- **响应示例**:
  ```json
  {
    "types": [
      { "id": "real-drama", "name": "真人剧" },
      { "id": "comic-drama", "name": "漫剧" },
      { "id": "ai-drama", "name": "AI剧" }
    ],
    "tags": [
      { "id": "romance", "name": "爱情", "categoryId": "5000" },
      { "id": "period", "name": "年代", "categoryId": "5021" },
      { "id": "comeback", "name": "逆袭", "categoryId": "5031" },
      { "id": "urban", "name": "都市", "categoryId": "5022" },
      { "id": "costume", "name": "古装", "categoryId": "5007" },
      { "id": "fantasy", "name": "玄幻", "categoryId": "5008" },
      { "id": "suspense", "name": "悬疑", "categoryId": "5004" }
      // ... 共 24 个题材标签
    ]
  }
  ```

### 4. `GET /api/category/list` - 分类短剧列表 (支持类型/题材/分页)
- **参数**:
  - `type` (可选，字符串，默认 `real-drama`):
    - `real-drama`: 真人剧
    - `comic-drama`: 漫剧
    - `ai-drama`: AI 剧
  - `tag` (可选，字符串): 题材标识（如 `romance`、`comeback`、`urban` 等），留空表示全部分类。
  - `page` (可选，整数，默认 `1`): 分页页码（每页 24 部）。
- **请求示例**:
  - `GET /api/category/list?type=real-drama&page=1`
  - `GET /api/category/list?type=real-drama&tag=romance&page=1`
  - `GET /api/category/list?type=comic-drama&page=2`
- **响应示例**:
  ```json
  {
    "type": "real-drama",
    "tag": "romance",
    "page": 1,
    "items": [
      {
        "id": "7686713195246930968",
        "title": "首辅娇娘",
        "cover": "https://p3-novel.byteimg.com/...image",
        "badge": "全69集",
        "description": "现代杀手顾娇坠机穿越，成为侯府流落乡间的真千金...",
        "tags": "爱情/古风爱情/先婚后爱"
      }
    ]
  }
  ```

---

## 第三部分：榜单板块 (Rank)

对应官方页面：`https://hongguoduanju.com/rank/hot-drama`

### 5. `GET /api/rank/types` - 获取排行榜类型列表
- **功能**: 获取红果短剧官方支持的 4 大榜单类型。
- **响应示例**:
  ```json
  {
    "types": [
      { "id": "hot-drama", "name": "红果热播榜", "desc": "全站综合短剧热度风向标" },
      { "id": "hot-real-drama", "name": "真人剧热播榜", "desc": "高人气真人实景演绎精选" },
      { "id": "hot-ai-drama", "name": "AI剧热播榜", "desc": "前沿生成式AI短剧佳作" },
      { "id": "hot-comic-drama", "name": "漫剧热播榜", "desc": "精彩漫画与动态漫榜单" }
    ]
  }
  ```

### 6. `GET /api/rank/list` - 获取指定榜单分页列表 (Top 100)
- **参数**:
  - `type` (可选，字符串，默认 `hot-drama`):
    - `hot-drama`: 红果热播榜
    - `hot-real-drama`: 真人剧热播榜
    - `hot-ai-drama`: AI剧热播榜
    - `hot-comic-drama`: 漫剧热播榜
  - `page` (可选，整数，默认 `1`，范围 `1` ~ `5`):
    - 每页包含 20 部短剧，共 5 页（涵盖官方 Top 1 ~ Top 100 全量数据）。
- **请求示例**:
  - `GET /api/rank/list?type=hot-drama&page=1` (Top 1 ~ 20)
  - `GET /api/rank/list?type=hot-real-drama&page=2` (Top 21 ~ 40)
  - `GET /api/rank/list?type=hot-drama&page=5` (Top 81 ~ 100)
- **响应示例**:
  ```json
  {
    "type": "hot-drama",
    "page": 1,
    "pageSize": 20,
    "total": 100,
    "totalPages": 5,
    "items": [
      {
        "rank": 1,
        "id": "7691228619774905368",
        "title": "聚宝仙盆之杂灵根才是真BOSS第十三季",
        "badge": "全222集",
        "cover": "https://p3-novel.byteimg.com/...image",
        "heat": 99.8,
        "heatText": "99.8万",
        "scoreText": "9.5分",
        "favoriteText": "12.3万",
        "likeText": "45.6万",
        "description": "...",
        "tags": "玄幻/修真"
      }
    ]
  }
  ```

### 7. `GET /api/ranks` - 首页排行榜模块聚合数据 (前 9 名预览)
- **功能**: 一次性获取官方 4 大热播榜单（带 1~9 名排名顺序与榜单类型），专供首页横向排布板块使用。
- **响应示例**:
  ```json
  {
    "ranks": [
      {
        "key": "hot",
        "title": "红果短剧热播榜",
        "items": [
          { "rank": 1, "id": "7691228619774905368", "title": "聚宝仙盆之杂灵根才是真BOSS第十三季", "badge": "全222集", "cover": "..." },
          { "rank": 2, "id": "7692043430955863102", "title": "反向拿捏：和闺蜜穿七零带着婆婆一起离", "badge": "全126集", "cover": "..." },
          { "rank": 3, "id": "7686713195246930968", "title": "首辅娇娘", "badge": "全69集", "cover": "..." }
        ]
      }
    ]
  }
  ```

---

## 第四部分：短剧推荐体系 (Recommendations) ★独立模块★

推荐体系是驱动用户沉浸追剧、提升内容触达率的核心引擎。本模块提供 **全库个性化算法流** 与 **单剧特征同类关联** 两大维度的推荐能力，完全支持两端（Web、Windows）在首页瀑布流、播放器下方“看了又看”、全剧播毕推荐卡片等多种场景中的无缝嵌入。

```
┌─────────────────────────────────────────────────────────────────┐
│                     红果短剧双层推荐引擎架构                      │
├───────────────────────────────┬─────────────────────────────────┤
│    1. 全库流式算法推荐池      │     2. 单剧特征同类关联引擎     │
│   (GET /api/recommend)        │  (GET /api/series/:id/related)  │
├───────────────────────────────┼─────────────────────────────────┤
│ • 首页流式「为你推荐」频道    │ • 播放详情页下方「看了又看」     │
│ • 支持 page 分页滚动无限加载  │ • 自动提取当前短剧题材与核心标签│
│ • 官方算法综合热度与新剧加权  │ • 倒排检索同类高分短剧并过滤自身│
│ • 上游核心失效时无缝降级官方池│ • 一键换剧、片尾彩蛋推荐        │
└───────────────────────────────┴─────────────────────────────────┘
```

### 8. `GET /api/recommend` - 全库算法推荐流 / 首页瀑布流
- **功能**: 获取红果短剧海量推荐列表，支持分页流式加载，适合作为首页「推荐」频道或“猜你喜欢”无限滚动瀑布流。
- **请求方法**: `GET`
- **请求参数**:
  | 参数名 | 类型 | 必填 | 默认值 | 说明 |
  | :--- | :--- | :--- | :--- | :--- |
  | `page` | integer | 否 | `1` | 分页页码，从 1 开始 |
  | `pageSize` | integer | 否 | `20` | 每页数量（上游流式返回，通常为 12~24 条） |
- **请求示例**:
  ```http
  GET /api/recommend?page=1 HTTP/1.1
  Host: localhost:8788
  ```
- **字段级响应格式**:
  ```json
  {
    "page": 1,
    "items": [
      {
        "id": "7688669642994240537",
        "title": "天降俏弟媳，大姑子们追着宠",
        "cover": "https://p3-novel.byteimg.com/novel-pic/a3d326979cc4415358b92f0b21eeb328~tplv-shrink:640:0.image",
        "badge": "全73集",
        "description": "为母筹钱的夜店酒水促销组长明宜，遭亲弟算计，意外与权势滔天的梁家老幺梁聿辰有了一夜纠葛...",
        "tags": "爱情/都市爱情/日久生情/逆风翻盘/总裁"
      },
      {
        "id": "7683196130645003288",
        "title": "东北话事人",
        "cover": "https://p6-novel.byteimg.com/novel-pic/43f0ffd63ca46bc91f2482ee212df975~tplv-shrink:640:0.image",
        "badge": "全71集",
        "description": "1997年下岗潮，东北青年李川南下谋生，因长相酷似本地商会失联负责人...",
        "tags": "成长/逆袭翻身/多重身份/权力斗争/大男主"
      }
    ]
  }
  ```
- **容灾与降级机制**:
  - 优先调用上游核心智能推荐流（`UPSTREAM_CORE/api/home?page={page}`）；
  - 若上游短时不可用，自动无缝降级到官方 Web 分类精选池（`fetchOfficialCategory("real-drama", "", page)`），确保高可用、零报错返回。

---

### 9. `GET /api/series/:id/related` - 单剧同类相关推荐 / 猜你喜欢
- **功能**: **根据当前观看/打开的短剧，自动提取其核心题材与剧情标签，精准检索匹配同类的高热度短剧推荐**（例如用户正在看都市豪门爱情剧，系统自动推荐同类优质豪门霸总短剧），适合在播放页下方或右侧展示“同类推荐/看了又看”。
- **请求方法**: `GET`
- **URL 路径参数**:
  - `id`: 当前短剧唯一 ID（如 `7503745441910017049`）
- **Query 查询参数**:
  | 参数名 | 类型 | 必填 | 默认值 | 说明 |
  | :--- | :--- | :--- | :--- | :--- |
  | `limit` | integer | 否 | `10` | 返回推荐部数（建议 6~12 部） |
- **请求示例**:
  ```http
  GET /api/series/7503745441910017049/related?limit=6 HTTP/1.1
  Host: localhost:8788
  ```
- **字段级响应格式**:
  ```json
  {
    "seriesId": "7503745441910017049",
    "keyword": "爱情",
    "items": [
      {
        "id": "7683137398225505305",
        "title": "蛇宠心尖",
        "cover": "https://p6-novel.byteimg.com/novel-pic/bc0cf84cffabad420ca836c72899e49b~tplv-shrink:640:0.image",
        "badge": "全34集",
        "description": "女孩偶然救下一只受伤的小黑蛇，好心将它带回家悉心照料...",
        "tags": "恋爱/异能/反转/都市/豪门"
      },
      {
        "id": "7688736152076962840",
        "title": "诱情染指之黎野入怀",
        "cover": "https://p3-novel.byteimg.com/novel-pic/8644e220456e32f6eb751fc683fa4e6d~tplv-shrink:640:0.image",
        "badge": "全66集",
        "description": "那一年她十八，祁野二十三。她身处地狱，岌岌可危...",
        "tags": "恋爱/都市"
      },
      {
        "id": "7686072059385875481",
        "title": "以余生为诺，护你岁岁无忧",
        "cover": "https://p3-novel.byteimg.com/novel-pic/7f7c44de02151b7901897fb99577d078~tplv-shrink:640:0.image",
        "badge": "全93集",
        "description": "医学院的女学生辛知婉，在结束一场失意的暗恋之后...",
        "tags": "恋爱/校园/都市"
      }
    ]
  }
  ```
- **核心算法机制**:
  1. **标签语义解析**：从当前剧详情 `tags` 中提取最高权重关键词（如 `爱情`、`逆袭`、`战神`、`悬疑`、`古装`）；
  2. **精准语义召回**：通过全库搜索索引检索该标签下的热播短剧；
  3. **自身剧集去重**：自动过滤匹配列表中当前正在播放的短剧本身；
  4. **推荐池数量补全**：若同标签短剧数量不足 `limit`，自动从官方综合推荐池中补足优质短剧，保证推荐位饱满展示。

---


---

## 第五部分：片库搜索 (Search)

### 10. `GET /api/search` - 全库关键词搜索

- **参数**: `q` (关键词，必填), `page` (页码，默认 1)
- **请求示例**: `GET /api/search?q=战神&page=1`
- **响应示例**:
  ```json
  {
    "items": [
      {
        "id": "7683196130645003288",
        "title": "东北话事人",
        "cover": "https://...",
        "badge": "全71集",
        "description": "...",
        "tags": "逆袭/热血"
      }
    ],
    "page": 1
  }
  ```

---

## 第六部分：详情与媒体流 (Player & Stream)

### 11. `GET /api/series/:id` - 短剧详情与全集列表
- **功能**: 获取指定短剧的完整信息及所有剧集 `episodes`。
- **响应示例**:
  ```json
  {
    "id": "7503745441910017049",
    "title": "宴律，你的白月光回国了",
    "cover": "https://...",
    "badge": "全76集",
    "description": "...",
    "tags": "都市爱情/都市/破镜重圆",
    "episodes": [
      { "id": "7503780574541122622", "title": "第 1 集", "number": 1 },
      { "id": "7503780577347128382", "title": "第 2 集", "number": 2 }
    ]
  }
  ```

### 12. `GET /api/episodes/:id/qualities` - 官方视频实际拥有多清晰度画质列表
- **功能**: **实时从官方视频模型动态解析该分集实际拥有的全部清晰度档位**，完全对齐官方手机 App（绝不漏缺任何一档实际存在的清晰度，绝不填充假数据）。
- **实际支持档位与编码（完全对齐手机红果 App 选项）**:
  - 🥇 **1080P 超清** (`1080p`, `video_5`, 分辨率 1080×1920, `HEVC`)
  - 🥈 **720P 高清** (`720p`, `video_4`, 分辨率 720×1280, `HEVC`)
  - 🥉 **540P 高清** (`540p`, `video_3`, 分辨率 540×960, `HEVC`)
  - 🎖️ **480P 标清** (`480p`, `video_2`, 分辨率 480×854, `HEVC`)
  - 🎖️ **360P 流畅** (`360p`, `video_1`, 分辨率 360×640, `HEVC`)
  *(按视频实际拥有的档位自适应返回并从高到低排序，最高清晰度默认置为 `isDefault: true`)*
- **请求参数**: `series_id` / `seriesId` (可选)
- **请求示例**: `GET /api/episodes/7690223053078268953/qualities?series_id=7690163276214176792`
- **响应示例**:
  ```json
  {
    "episodeId": "7690223053078268953",
    "defaultQuality": "1080P",
    "qualities": [
      { "key": "1080P", "label": "1080P 超清", "qualityNum": 1080, "codec": "HEVC", "rawKey": "video_5", "isDefault": true },
      { "key": "720P", "label": "720P 高清", "qualityNum": 720, "codec": "HEVC", "rawKey": "video_4", "isDefault": false },
      { "key": "540P", "label": "540P 高清", "qualityNum": 540, "codec": "HEVC", "rawKey": "video_3", "isDefault": false },
      { "key": "480P", "label": "480P 标清", "qualityNum": 480, "codec": "HEVC", "rawKey": "video_2", "isDefault": false },
      { "key": "360P", "label": "360P 流畅", "qualityNum": 360, "codec": "HEVC", "rawKey": "video_1", "isDefault": false }
    ]
  }
  ```

### 13. `GET /api/episodes/:id/play` - 单集播放解析
- **参数**: `quality` (`1080P`, `720P`, `540P`, `480P`, `360P`，默认 `1080P`), `series_id` (可选)
- **功能**: 解析单集视频播放路径。
- **响应示例**:
  ```json
  {
    "path": "/api/episodes/7690223053078268953/stream?quality=1080P&seriesId=7690163276214176792",
    "contentType": "video/mp4"
  }
  ```

### 14. `GET /api/episodes/:id/stream` - 标准 MP4 视频媒体流
- **参数**: `quality` (`1080P`, `720P`, `540P`, `480P`, `360P`，默认最高画质), `seriesId` (可选)
- **功能**: **真正的音视频媒体流**。播放器直接传入此 URL 即可播放。
- **支持特性**:
  - 🎬 **官方全画质按需调度**：根据传入的 `quality` 精确解析对应的视频流与派生 AES 密钥。
  - 🔐 **服务端底层实时解密**：原生 CENC AES-128-CTR 块解密，输出纯净标准 MP4。
  - ⚡ **完整 HTTP Range 分段请求**：支持任意时间戳拖拽快进/快退，毫秒级响应。

### 15. 家庭共享观看历史

新增 `/api/history` 查询／删除、`/api/history/sessions` 会话注册、`/api/history/progress` 实时进度及 `/api/history/import` 本地迁移接口。支持 `all/web/pc/tv` 来源，SQLite 持久化，所有进度单位为毫秒。完整契约、删除规则与部署位置见 [共享历史说明](../docs/SHARED_HISTORY.md)。




# 内容后台、观看权限与分集互动

正式后台入口为 `/admin`，沿用真实账户的 HttpOnly 会话，VIP 身份不会取得管理权限。先注册管理账户，从 `/api/account/session` 读取 `user.id`，配置 `ADMIN_ACCOUNT_IDS` 后重启服务。`ADMIN_EMAILS` 仅适用于已验证邮箱的账户；邮件服务尚未接入时使用账户编号方式。不要设置公开的默认管理员密码。

后台通过真实分类接口提供可选题材，保存不随界面翻译变化的 `categoryIds`；用户输入的剧名、简介和 `tags` 保留原始内容。自有上架内容独立进入推荐池，不等待外部内容源，列表接口只传递卡片元数据。

登录保留当前剧集位置与会员套餐。Google登录、结算和订阅管理的 `returnTo` 只允许本站 `/` 及数字剧集标识、会员页面和月付/年付选项，外站地址及任意令牌参数被丢弃。支付服务未配置时不会创建虚假订单或解锁会员。

每部短剧按真实分集顺序计算：前三集免费，第四集起需有效会员。服务端对画质、播放地址、视频流与 HEAD/Range 请求逐次校验会话及分集归属；会员过期或撤销后，后续请求被拒绝。管理员可以预览草稿和付费分集。外部公开内容源仍由原站控制，本站权限不能限制原站地址。

| 接口 | 用途 |
| --- | --- |
| `GET /api/admin/series?q=&page=1` | 查询自有短剧、草稿及上架状态 |
| `POST /api/admin/series`、`POST /api/admin/series/:id` | 创建及编辑真实剧名、简介、分类、语言与封面 |
| `GET /api/admin/series/:id` | 分集详情与关联素材，供编辑和预览 |
| `POST /api/admin/series/:id/episodes` | `mode:append` 新增；明确替换使用 `mode:replace`、`expectedEpisodeId` 和 `expectedAssetId` 校验原分集；重复保存同一素材可重试，上架期间禁止修改 |
| `DELETE /api/admin/series/:id/episodes/:episodeId` | 从草稿移除分集，原文件保留 |
| `POST /api/admin/series/:id/reorder` | 传入完整 `ids` 数组调整连续集序 |
| `POST /api/admin/series/:id/publish` | `status` 为 `published` 或 `draft`；缺封面、缺分集、集数不连续不能发布 |
| `POST /api/admin/uploads` | 使用文件名、大小、MIME 与 `kind` 创建真实上传记录 |
| `PUT /api/admin/uploads/:id` | 二进制分块，每块不超过 1MB，携带 `Content-Range: bytes 起点-终点/总大小` |
| `GET /api/admin/uploads/:id`、`GET /api/admin/uploads?page=1` | 读取断点、处理状态与错误，恢复上传或轮询处理结果 |
| `DELETE /api/admin/uploads/:id` | 上传所属管理员取消未完成上传，释放待处理额度并清理临时文件；写入或处理期间需稍后重试，已完成素材保留 |
| `GET /api/admin/accounts?q=&page=1` | 查询真实账户及会员状态，不返回密码和会话令牌 |
| `POST /api/admin/membership` | `accountId`、毫秒时间戳 `periodEnd`、`reason` 开通手动会员；`revoke:true` 撤销手动权益 |
| `GET /api/admin/comments?page=1` | 查询评论和举报数 |
| `POST /api/admin/comments/:id` | `status` 为 `visible`、`hidden` 或 `deleted`，记录管理操作 |
| `GET /api/admin/audit?page=1` | 查询上传、内容发布、会员及审核操作记录 |
| `GET /api/episodes/:id/interactions?seriesId=` | 单集真实点赞数、评论数和当前账户点赞状态 |
| `POST /api/episodes/:id/likes?seriesId=` | 登录后传入布尔值 `liked`，同一账户重复请求不重复计数 |
| `GET /api/me/likes?before=` | 当前登录账户点赞的单集、真实总数及下一页 `next` 游标；`summary=1` 只返回总数，不接受指定其他账户 |
| `POST /api/me/likes/:id` | 当前账户取消该单集点赞，支持已下架或缺少内容信息的旧记录；返回剩余总数 |
| `GET /api/episodes/:id/comments?seriesId=&before=` | 使用返回的 `next` 游标读取公开评论，同一毫秒发布的评论不会漏项 |
| `POST /api/episodes/:id/comments?seriesId=` | 登录后发布不超过1000字符的评论 |
| `DELETE /api/comments/:id` | 作者删除自己的评论 |
| `POST /api/comments/:id/report` | 登录账户举报评论，同账户不重复计数 |

本轮媒体存于 `HG_DATA_DIR/media`，配置该目录的持久化磁盘。视频默认上限 2GB，封面上限 8MB。生产 Docker 镜像包含 FFmpeg；本机开发需提供 `FFMPEG_PATH` 与 `FFPROBE_PATH`，默认从 PATH 查找。视频限定 MP4、8位H.264的4:2:0像素格式与AAC音轨，分辨率不超过4096像素。服务端读取实际媒体信息并整理为快速起播文件，完成前不能发布。处理状态在服务重启时标为失败，需重新上传，不能假报成功。分块网络失败后重新选择同一文件即可从服务端真实偏移继续上传。

剧集编辑页可直接选择封面、多选或拖入 MP4。文件按名称中的集数识别并自然排序，管理员先确认集数、标题和顺序，再开始两条并行上传。上传字节完成后仍等待服务端实际处理成功，随后自动保存封面或分集；补集默认禁止覆盖，指定替换校验原分集是否变化。发布前检查有效封面及从第1集开始的连续分集。

上传队列按管理员账户保存在当前浏览器，记录剧集归属、原始文件大小、修改时间及首尾内容摘要；本地文件不会保存到浏览器持久化存储。切换后台模块时任务继续，刷新后未传完的文件需重选原文件并校验身份，已上传的素材可继续轮询与保存。断点以服务端 `offset` 为准；处理后的 `size` 可能变化，不作为原文件续传长度。清除完成记录不会删除素材或分集。

手动会员和真实支付订阅独立，撤销手动权益不会取消真实收费；订阅必须通过已有支付管理入口处理。分享链接使用 `/?series=短剧编号&episode=分集编号`，接收人仍需通过同样的会员校验。

点赞时服务端保存实际内容源的短剧与分集关联，列表点击后继续通过播放接口检查分集和会员权限。已下架的自有内容标记为不可播放，仍可取消点赞。旧点赞记录不会删除：自有分集直接恢复归属；外部记录在再次访问原分集时补全，补全前不猜测剧名或播放地址。

