# 节点目录（App 端服务发现的权威源）

App 启动时从 GitHub raw 拉取本文件：

```
https://raw.githubusercontent.com/OpenWTU/charging-crawler/main/server/p2p/nodes.json
```

## 加节点

1. 部署一个新节点（Node 版，读写模式）
2. 把它的 HTTP 地址（`url`）和 libp2p 地址（`p2p`，可选）加进 `nodes.json`，走 PR 合入 main
3. App 下次启动自动拉取，健康检查通过后即可切换过去

## 字段

- `id`：节点唯一标识（人读）
- `url`：HTTP 地址（App 直接连这个，末尾不带 `/`）
- `p2p`：libp2p multiaddr（可选，服务器节点之间互连用）

## 兜底

App 内置 `https://charge.lizishuo.cn` 作为最后兜底；GitHub 和所有节点都不可达时
仍能工作（退回单节点行为）。
