"""上传 / 刷新 / 设备注册（/api/snapshot、/api/refresh、/api/device/register、/internal/token）"""

from __future__ import annotations
import hashlib
import hmac
import json
import re
import sqlite3
import sys
import time
from .. import config as config_mod
from ..config import (MAX_BODY, MAX_SKEW, NONCE_RE, invalidate_areas_ports_cache, now_str)
from ..ports import (_clean_ports, record_pile_sample, status_group)
from ..prediction import (invalidate_prediction_cache)
from ..refresh import _round_ok, refresh_round
from ..security import decrypt_token, encrypt_token, rate_ok
from ..snapshots import validate_payload
from ..store import device_approval_enabled, split_valid_areas, upsert_area
from ..tokens import _pool_upsert, parse_token


class ApiUploadMixin:
    """ApiUpload 路由族（mixin）"""

    def _api_post(self, path: str) -> bool:
        """POST 路由：命中返回 True，未命中交回门面 404。"""
        if path == "/api/device/register":
            self._register_device()
            return True
        if path == "/api/refresh":
            self._refresh()
            return True
        if path == "/api/snapshot":
            self._upload_snapshot()
            return True
        return False

    def _refresh(self) -> None:
        """手动刷新：与 worker 同一轮逻辑（先区域后端口）。"""
        if not self._admin_session():
            self._error(401, "需要管理员登录后才能刷新")
            return
        # 与 /admin/api/* 一致：有 Origin 时必须同源；无 Origin（CLI/脚本）放行。
        origin = self.headers.get("Origin")
        host = self.headers.get("Host", "")
        if origin and origin not in ("http://" + host, "https://" + host):
            self._error(403, "origin 校验失败")
            return
        ip = self._client_ip()
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > 4096:
            self._error(413, "请求体过大")
            return
        if length > 0:
            self.rfile.read(length)
        if not rate_ok(ip, "refresh", 2, 60):
            self._error(429, "刷新过于频繁")
            return
        nowts = time.time()
        if nowts - config_mod.REFRESH_LAST < 180:
            self._error(429, "刷新冷却中，请稍后再试")
            return
        try:
            # 手动刷新与 worker 同一轮逻辑：先区域快照再端口状态。
            result = refresh_round(self.db, self.server.db_lock)
        except Exception as exc:
            sys.stderr.write(f"[refresh] {exc!r}\n")
            self._error(500, "刷新失败")
            return
        if result == "skip:busy":
            self._json(409, {"ok": False, "error": "正在刷新，请稍候"})
            return
        ok = _round_ok(result)
        if ok:
            # 只有成功才占用 180 秒冷却；失败/部分失败允许紧接着重试（仍受 2 次/分限制）。
            config_mod.REFRESH_LAST = nowts
        self._json(200, {"ok": ok, "result": result})
        return

    def _upload_snapshot(self) -> None:
        """设备上传快照：签名 → 逐区校验 → 端口校验 → 单事务落库 → 解析 token。"""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._error(400, "Content-Length 非法")
            return
        if length <= 0 or length > MAX_BODY:
            if length > MAX_BODY:
                self._audit(self._client_ip(),
                            self.headers.get("User-Agent", ""), length,
                            "too_large")
            self._error(413 if length > MAX_BODY else 400, "请求体大小非法")
            return
        body = self.rfile.read(length)
        ip = self._client_ip()
        ua = self.headers.get("User-Agent", "")
        if not rate_ok(ip, "upload", 12, 60):
            self._audit(ip, ua, length, "rate_limited")
            self._json(429, {"ok": False, "error": "上传过于频繁，请稍后再试"})
            return

        ts = (self.headers.get("X-Charge-Timestamp") or "").strip()
        nonce = (self.headers.get("X-Charge-Nonce") or "").strip()
        sig = (self.headers.get("X-Charge-Signature") or "").strip().lower()
        try:
            ts_int = int(ts)
        except ValueError:
            self._error(401, "时间戳非法")
            return
        if abs(time.time() - ts_int) > MAX_SKEW:
            self._audit(ip, ua, length, "bad_ts")
            self._error(401, "时间戳过期")
            return
        if not NONCE_RE.match(nonce):
            self._error(401, "nonce 非法")
            return
        device_id = (self.headers.get("X-Device-Id") or "").strip()
        device_ok = False
        device_pending = False
        if device_id and len(sig) == 64:
            with self.server.db_lock:
                row = self.db.execute(
                    "SELECT secret_enc, revoked, status FROM devices WHERE device_id = ?",
                    (device_id,)).fetchone()
            if row and not row[1] and (row[2] or "approved") != "revoked":
                try:
                    dev_secret = decrypt_token(row[0])
                    dev_sig = hmac.new(dev_secret.encode(), ts.encode() + b"\n"
                                       + nonce.encode() + b"\n" + body,
                                       hashlib.sha256).hexdigest()
                    device_ok = hmac.compare_digest(sig, dev_sig)
                except Exception:
                    device_ok = False
                if device_ok and (row[2] or "approved") == "pending":
                    device_pending = device_approval_enabled(self.db)
                    if not device_pending:
                        # 审批已关闭：pending 设备视为已通过，避免还要手动批准一次
                        with self.server.db_lock:
                            self.db.execute(
                                "UPDATE devices SET status='approved' WHERE device_id=?",
                                (device_id,))
                            self.db.commit()
        if not device_ok:
            self._audit(ip, ua, length, "bad_sig")
            self._error(401, "签名校验失败（设备未注册或已撤销）")
            return
        if device_pending:
            self._audit(ip, ua, length, "pending",
                        f"dev={device_id[:12] or '-'}")
            self._json(403, {"error": "设备待管理员审批"})
            return
        try:
            obj = json.loads(body.decode("utf-8"))
            raw_token = obj.get("token") if isinstance(obj, dict) else None
            payload = validate_payload(obj)
            raw_ports = obj.get("ports") if isinstance(obj, dict) else None
        except (ValueError, TypeError, UnicodeDecodeError) as exc:
            self._audit(ip, ua, length, "bad_body")
            sys.stderr.write(f"[validate] {exc!r}\n")
            self._error(400, "数据非法")
            return

        real_ip = self._client_ip()
        with self.server.db_lock:
            # H1：逐区校验，未知区/不守恒区只跳过本区；全部非法才 400。
            valid_areas, skipped_areas, duplicate = split_valid_areas(
                self.db, payload["areas"])
            if duplicate:
                self._audit(ip, ua, length, "invalid",
                            f"区域重复 dev={device_id[:12] or '-'}")
                self._error(400, "区域重复")
                return
            if not valid_areas:
                reason = skipped_areas[0][1] if skipped_areas else "区域数据非法"
                skipped_text = ",".join(f"{n}:{r}" for n, r in skipped_areas[:5])
                self._audit(ip, ua, length, "invalid",
                            f"{reason} skipped={len(skipped_areas)} "
                            f"[{skipped_text}] dev={device_id[:12] or '-'}")
                self._error(400, reason)
                return
            payload["areas"] = valid_areas
            # 端口校验放在 nonce 落库之前：坏请求不消耗 nonce，也不写快照/端口。
            known_devices = {row[0] for row in self.db.execute(
                "SELECT device_hex FROM controllers")}
            try:
                clean_ports = _clean_ports(raw_ports, known_devices)
            except (ValueError, TypeError) as exc:
                self._audit(ip, ua, length, "invalid_ports",
                            f"{exc} dev={device_id[:12] or '-'}")
                self._error(400, "端口数据非法")
                return
            try:
                self.db.execute(
                    "INSERT INTO nonces(nonce, seen_at) VALUES (?, ?)",
                    (nonce, int(time.time())))
            except sqlite3.IntegrityError:
                self.db.rollback()
                self._audit(ip, ua, length, "replay")
                self._error(409, "nonce 已使用（疑似重放）")
                return
            try:
                # 单事务：快照 + 区域样本 + 端口 + 设备计数 + nonce 清理，仅一次 commit
                with self.db:
                    cursor = self.db.execute(
                        """INSERT INTO snapshots(received_at, captured_at, project,
                                                 app_version, token_user, client_ip,
                                                 device_id, real_ip, body_sha256, payload)
                           VALUES (?,?,?,?,?,?,?,?,?,?)""",
                        (
                            now_str(), payload["captured_at"], payload["project"],
                            payload["app_version"], payload["token_user"],
                            self.client_address[0], device_id, real_ip,
                            hashlib.sha256(body).hexdigest(),
                            json.dumps(payload, ensure_ascii=False),
                        ),
                    )
                    row_id = cursor.lastrowid
                    stamp = now_str()
                    self.db.executemany(
                        """INSERT INTO area_samples(snapshot_id, area_id, area_name, idle,
                                                    total, charging, fault, received_at)
                           VALUES (?,?,?,?,?,?,?,?)""",
                        [(row_id, upsert_area(self.db, a["name"]), a["name"],
                          a["idle_port"], a["total_port"], a["charging_port"],
                          a["fault_port"], stamp)
                         for a in payload["areas"]],
                    )
                    for item in clean_ports:
                        entries = item["ports"]
                        dev = item["device_hex"]
                        for p in entries:
                            self.db.execute(
                                "INSERT INTO port_states(device_hex, port, status, "
                                "status_group, updated_at) VALUES (?,?,?,?,?) "
                                "ON CONFLICT(device_hex, port) DO UPDATE "
                                "SET status=excluded.status, "
                                "status_group=excluded.status_group, "
                                "updated_at=excluded.updated_at",
                                (dev, p["port"], p["status"], p["group"], stamp))
                        self.db.execute(
                            "UPDATE controllers SET updated_at = ? WHERE device_hex = ?",
                            (stamp, dev))
                        # 单桩采样：每次上传设备端口写一条，同一秒 REPLACE。
                        if entries:
                            record_pile_sample(self.db, dev, stamp,
                                               [p["status"] for p in entries])
                    self.db.execute("DELETE FROM nonces WHERE seen_at < ?",
                                    (int(time.time()) - 600,))
                    if device_id:
                        self.db.execute(
                            "UPDATE devices SET uploads=uploads+1, last_seen=? "
                            "WHERE device_id=?", (stamp, device_id))
            except Exception as exc:
                sys.stderr.write(f"[store] {exc!r}\n")
                self._audit(ip, ua, length, "store_error",
                            f"{exc!r} dev={device_id[:12] or '-'}")
                self._error(500, "入库失败")
                return
        self._audit(ip, ua, length, "ok",
                    f"areas={len(payload['areas'])} "
                    f"skipped={len(skipped_areas)} "
                    f"dev={(device_id[:12] or '-')}")
        # 新的 area_samples 已落库：让预测缓存立即失效（最多 60 秒旧值的兜底不需要）。
        invalidate_prediction_cache()
        if clean_ports:
            invalidate_areas_ports_cache()
        if isinstance(raw_token, str) and raw_token.startswith("ey"):
            try:
                parsed = parse_token(raw_token)
                if parsed:
                    uid, exp = parsed
                    enc = encrypt_token(raw_token)
                    with self.server.db_lock:
                        with self.db:
                            # 兼容表 tokens 继续写；token_pool 是轮换的唯一来源。
                            self.db.execute(
                                """INSERT INTO tokens(user_id, token, expires_at, updated_at)
                                   VALUES (?,?,?,?)
                                   ON CONFLICT(user_id) DO UPDATE SET token=excluded.token,
                                       expires_at=excluded.expires_at,
                                       updated_at=excluded.updated_at""",
                                (uid, enc, exp, now_str()))
                            _pool_upsert(self.db, uid, enc, exp, source="upload")
                    self._audit(ip, ua, 0, "token_update",
                                f"user={uid} dev={device_id[:12] or '-'}")
            except Exception as exc:
                sys.stderr.write(f"[token] 保存失败: {exc!r}\n")
        self._json(200, {"ok": True, "id": row_id,
                         "accepted": len(payload["areas"]),
                         "skipped": len(skipped_areas)})

    def _register_device(self) -> None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._error(400, "Content-Length 非法")
            return
        if length <= 0 or length > 4096:
            self._error(400, "请求体大小非法")
            return
        body = self.rfile.read(length)
        ip = self._client_ip()
        ua = self.headers.get("User-Agent", "")
        try:
            obj = json.loads(body.decode("utf-8"))
        except Exception:
            self._error(400, "不是合法 JSON")
            return
        if not isinstance(obj, dict):
            self._error(400, "请求体必须是 JSON 对象")
            return
        did = str(obj.get("device_id") or "").strip()
        secret = str(obj.get("secret") or "").strip().lower()
        if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", did) or not re.fullmatch(r"[0-9a-f]{64}", secret):
            self._error(400, "device_id/secret 非法")
            return
        # 反滥用：参数校验通过后才消耗 5 次/天 配额，坏请求不再挤占注册额度。
        if not rate_ok(ip, "register", 5, 86400):
            self._audit(ip, ua, length, "register_rate")
            self._error(429, "注册过于频繁")
            return
        try:
            secret_enc = encrypt_token(secret)
        except Exception as exc:
            sys.stderr.write(f"[register] 密钥不可用: {exc!r}\n")
            self._audit(ip, ua, length, "register_key_error",
                        f"dev={did[:12]}")
            self._error(503, "服务端密钥不可用，请联系管理员")
            return
        with self.server.db_lock:
            existed = self.db.execute(
                "SELECT secret_enc, revoked, status FROM devices WHERE device_id = ?", (did,)).fetchone()
            if existed is not None:
                # 空 secret_enc 是管理员 reset-secret 后的“待重新注册”状态。
                if str(existed[0] or ""):
                    try:
                        same = hmac.compare_digest(decrypt_token(existed[0]), secret)
                    except Exception:
                        same = False
                    if not same:
                        # code 供 Android 区分「换机/密钥不一致」与「已被撤销」，error 文案保持不变。
                        self._json(409, {"ok": False, "code": "secret_mismatch",
                                         "error": "device_id 已被注册，请联系管理员重置"})
                        return
                if existed[1] or (existed[2] or "") == "revoked":
                    self._json(409, {"ok": False, "code": "revoked",
                                     "error": "设备已被撤销，请联系管理员"})
                    return
            approval_on = device_approval_enabled(self.db)
            with self.db:
                self.db.execute(
                    """INSERT INTO devices(device_id, secret_enc, model, app_version,
                                           created_at, status)
                       VALUES (?,?,?,?,?,?)
                       ON CONFLICT(device_id) DO UPDATE SET secret_enc=excluded.secret_enc,
                           model=excluded.model, app_version=excluded.app_version""",
                    (did, secret_enc, str(obj.get("model") or "")[:80],
                     str(obj.get("app_version") or "")[:32], now_str(),
                     "pending" if approval_on else "approved"))
                row = self.db.execute(
                    "SELECT status, revoked FROM devices WHERE device_id = ?",
                    (did,)).fetchone()
            pending = bool(row and row[0] == "pending" and not row[1])
        self._audit(ip, ua, length, "register", did)
        if pending:
            self._json(200, {"ok": True, "pending": True})
        else:
            self._json(200, {"ok": True, "device_id": did})
