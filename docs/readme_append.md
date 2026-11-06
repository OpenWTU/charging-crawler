## 当前版本与部署（2026-11-01）

- 最新 App：v1.1.6（versionCode 107），release keystore 签名（CN=ChargingApp）。
- 线上：https://charge.example.com/（Vue3 + Vant + ECharts），管理页 https://charge.example.com/admin。
- App 内页面同样由 `webui` 构建（Vite 多入口），通过虚拟域名 `appassets.androidplatform.net` 加载本地 assets，JS 桥为 `AndroidHost`。

### 构建与部署

```
# 前端（Vue）
cd webui
node <bundled>/pnpm.mjs install
node <bundled>/pnpm.mjs run build   # 输出 cloud/web/dist

# App
python android/build.py             # 自动同步 dist、生成 version_clean.json（含 sha256）

# 一键部署
pwsh -File deploy.ps1               # 构建前端+测试+APK，上传并重启
```

### 更新与校验

- `version.json` 由构建自动生成：versionCode/versionName/apkPath/sizeText/sha256。
- App 下载后校验 sha256，不一致删除安装包并提示。
- 旧版 debug 签名（2.x）无法覆盖安装 1.1.x，需先卸载；会清 token，重新抓取即可。

### 服务端要点

- 上传 HMAC + 时间戳 + nonce 防重放，限流 12 次/分钟/IP。
- token AES-GCM 加密存储（`/etc/charge-cloud/token_key`），worker 每 10 分钟用最新有效 token 主动抓取。
- 读接口 120 次/分钟/IP；analytics 60 秒缓存；admin 10 次/5 分钟/IP。
- 管理页 Basic 认证，口令在 `/etc/charge-cloud/admin.env`（600）；已于 2026-11-01 轮换，仓库中不再保存明文。
