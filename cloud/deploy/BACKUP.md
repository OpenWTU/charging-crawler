# 备份安装与校验（charge-cloud）

每日两段备份，按顺序执行：

1. `03:17` `charge-db-backup.sh`
   - SQLite `wal_checkpoint(TRUNCATE)` + `src.backup()` 生成 `charge-YYYY-MM-DD.db`；
   - 打包 `/etc/charge-cloud` + `/var/lib/charge-cloud/token_key` + `version.json`；
   - 校验 DB 的 `PRAGMA integrity_check`、配置包必须含 `token_key`；
   - 生成 `charge-YYYY-MM-DD.manifest`（sha256）。
   - 目录/文件 root:root 700/600，保留 90 天。
2. `03:20` `charge-backup-bundle.sh`
   - 只接受**当天**的 DB/config，否则失败（避免打包昨天的旧备份）；
   - 再次校验 DB 完整性、config 包内 token_key；
   - 打包 DB + config + token_key + version.json + 源码 + `MANIFEST`；
   - 生成 `*.sha256`；周日的 bundle 额外复制到 `weekly/`；
   - 目录/文件 root:root 700/600，保留 90 天。

安装（root）：

```bash
install -m 755 charge-db-backup.sh /usr/local/bin/charge-db-backup.sh
install -m 755 charge-backup-bundle.sh /usr/local/bin/charge-backup-bundle.sh
install -m 644 charge-backup.cron /etc/cron.d/charge-backup
install -m 644 charge-bundle.cron /etc/cron.d/charge-bundle
```

> 两个脚本默认按 root 运行（脚本内 `chown root:root`）。在**非 root** 环境验证脚本本身
> （本机调试、容器、Git Bash）时，请设 `CHARGE_SKIP_CHOWN=1`，否则 `set -e` 会因
> `chown: invalid user: 'root:root'` 直接中断；单元测试 `test_backup_scripts_with_temp_dirs`
> 就是这样调用的。

权限：

- 两个 `.sh` 必须 755（cron 直接执行）；`/etc/cron.d/*` 用 644/root。
- `backups/` 与 `backups/nas/` 必须 root:root 700；NAS 拉取（rrsync/SMB）必须用 root
  或加入同一权限组，否则 700 目录会挡住非 root 拉取。
- `token_key` 必须与 DB 同批恢复；缺 key 时服务启动会拒绝（1.11.17+）。

恢复演练（至少每季度）：

```bash
sha256sum -c charge-YYYY-MM-DD-full.tar.gz.sha256
tar tzf charge-YYYY-MM-DD-full.tar.gz
# 解包后核对 MANIFEST 的 db/config sha256；再用 charge-config.tgz 里的 token_key 启动
```

NAS 端建议用 `rrsync` 限定只读目录 `/var/lib/charge-cloud/backups/nas`，并以 root
（或能读 700 目录的专用账号）执行；`charge-backup.cron`/`charge-bundle.cron` 的时间
与 `Asia/Shanghai` 时区由脚本内 `TZ` 固定。
