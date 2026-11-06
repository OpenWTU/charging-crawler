### 设备密钥（v1.1.8 起）

- App 首次启动生成 `device_id`（16 字节 hex）与 `device_secret`（32 字节 hex），secret 用 Android Keystore AES/GCM 加密保存在本地。
- 上传使用设备密钥做 HMAC（`X-Device-Id` + `X-Charge-Signature`），不再使用 APK 内置的全局密钥。
- 首次上传返回 401 时，App 自动 `POST /api/device/register` 注册设备并重试一次，用户无感。
- 服务端 `devices` 表记录机型、版本、首次/最近上传时间与上传次数；`GET /admin/api/devices` 查看，`POST /admin/api/device/revoke` 撤销/恢复。
- 旧全局 HMAC 兼容已移除：未注册/已撤销设备的快照上传一律 401。
