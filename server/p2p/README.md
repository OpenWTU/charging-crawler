# P2P 白名单（权威源）

本文件是 peerId 白名单的**权威源**，节点启动时从 GitHub raw 拉取：

```
https://api.github.com/repos/OpenWTU/charging-crawler/contents/server/p2p/nodes.json
```

## 怎么加节点

1. 在要加入的节点上启动 P2P（`P2P_ENABLED=true`），`/status` 会显示它的 `peers.self`（peerId）
2. 把那个 peerId 加进下面列表，走 PR 合入 main
3. 该节点（和其它节点）重启后自动拉取新白名单

## 安全约定

- **peerId 不是秘密**（公钥指纹），放公开仓库安全
- **节点私钥才是秘密**：每台服务器本地 `P2P_KEY_FILE`（默认
  `/var/lib/charge-cloud/p2p_key`），**绝不进仓库**
- 白名单为空 = 拒绝所有外部消息（单节点安全默认）
