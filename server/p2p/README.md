# 节点目录（唯一权威源：`nodes.json`）

本文件 `server/p2p/nodes.json` 是**节点目录 + peerId 白名单的单一真相源**，
App 与服务器共用（早期拆成 `nodes.json` + `peers.json` 两份，已合并）。

## 谁在用

| 使用方 | 读取字段 | 用途 |
|---|---|---|
| **App**（NodeDiscovery） | `url`、`name` | 启动时拉取，逐个 `/health` 探测，选第一个通的节点连接；状态页可手动切换 |
| **服务器**（P2P） | `peerId`、`p2p` | peerId 做消息鉴权白名单；`p2p` 地址做自动互连（启动即尝试 dial） |

拉取地址（GitHub contents API，`raw.githubusercontent.com` 在国内常被 TLS 阻断）：

```
https://api.github.com/repos/OpenWTU/charging-crawler/contents/server/p2p/nodes.json
```

请求头 `Accept: application/vnd.github.raw`（contents API 才返回原始 JSON）。

## 格式

```json
{
  "nodes": [
    {
      "peerId": "12D3KooW...",
      "name": "主节点",
      "url": "https://charge.lizishuo.cn",
      "p2p": "/ip4/8.148.70.133/tcp/4001"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `peerId` | 是 | 节点 libp2p 身份（`/status` 的 `peers.self`），白名单鉴权用 |
| `name` | 否 | 节点显示名（状态页卡片），缺省取 peerId 前 8 位 |
| `url` | App 需要 | 节点 HTTP 地址（不含末尾 `/`），App 直连用 |
| `p2p` | 建议填 | libp2p multiaddr（`/ip4/<IP>/tcp/4001`），服务器自动互连用 |

> 兼容旧格式：`{"peers": ["<peerId>", {"id","addr"}]}` 仍可解析，但不推荐。

## 加节点流程（3 步）

1. **部署新节点**（`server/deploy/install.sh` 一条命令），`/status` 里拿到它的
   `peers.self`（peerId）和公网 P2P 地址（`NODE_P2P_ADDR`）
2. **在本文件加一条**（peerId / name / url / p2p），走 PR 合入 main
3. **发版**（推 `v*` tag）→ 所有节点重启后自动拉取新目录：
   - 服务器：新 peerId 进入白名单（可收它的消息）+ 自动尝试连接它的 `p2p` 地址
   - App：新节点进入目录，可被发现和切换

## 自动互连与 NAT

- 节点启动时对目录里**所有** `p2p` 地址发起连接（不只一个 bootstrap）
- 谁先连上算谁：**只要一侧能出站连到另一侧**，连接即建立（TCP 全双工，
  单向建连后双向数据都通）——因此 NAT 后没有公网入口的一方也能被连上/连出去
- 因此**不需要人工判断连接方向**

## 安全约定

- **peerId / url / p2p 都不是秘密**（公钥指纹 + 公开地址），放公开仓库安全
- **节点私钥才是秘密**：每台服务器本地 `P2P_KEY_FILE`（默认
  `/var/lib/charge-cloud/p2p_key`，0600），**绝不进仓库**
- 消息鉴权用 libp2p `SignedMessage.from`（节点私钥签名验证的来源），
  不是消息内容里自填的 sender（后者可伪造）
- 白名单为空 = 拒绝所有外部消息（单节点安全默认）

## 兜底与降级

- 服务器：远程拉取失败 → 本地缓存（`/data/p2p_peers.json`）→ 镜像内默认值
  （`/app/default-peers.json`，随版本发布）
- App：远程拉取失败 → 上次成功节点（SharedPreferences）→ 内置
  `https://charge.lizishuo.cn`；缓存节点 `/health` 不通时自动回退目录里第一个通的

## 数据同步范围（重要）

P2P 只广播**新产生的快照**（上传/worker 抓取后实时广播，`body_sha256` 去重落库）。
**节点加入前的历史数据不会自动回填**——新节点从加入时刻开始积累自己的历史。
如需历史全量同步，需要额外的 backfill 机制（当前未实现）。
