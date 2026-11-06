"""离线构建 Android APK。
用法：
  python android/build.py                      # 发布构建：同步 web 产物 + 写 version_clean.json
  python android/build.py --no-version-json    # 只构建 APK，不改发布元数据（本地验证）
  python android/build.py --allow-stale-web    # 允许 webui/src 比 dist 新（紧急/验证构建）
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "app" / "src" / "main"
BUILD = ROOT / "build"
SDK = Path(os.environ.get("CHARGE_ANDROID_SDK", r"C:\Android\sdk"))
JDK = Path(os.environ.get("CHARGE_JAVA_HOME", r"C:\Android\jdk17"))
BT = SDK / "build-tools" / "34.0.0"
PLATFORM = SDK / "platforms" / "android-34" / "android.jar"
# 工具名跨平台（Windows 带 .exe/.bat，Linux 无后缀）
IS_WIN = os.name == "nt"
AAPT2 = BT / ("aapt2.exe" if IS_WIN else "aapt2")
D8 = BT / ("d8.bat" if IS_WIN else "d8")
ZIPALIGN = BT / ("zipalign.exe" if IS_WIN else "zipalign")
APKSIGNER = BT / ("apksigner.bat" if IS_WIN else "apksigner")
JAVAC = JDK / "bin" / ("javac.exe" if IS_WIN else "javac")
ENV = os.environ.copy()
ENV["JAVA_HOME"] = str(JDK)
ENV["PATH"] = str(JDK / "bin") + os.pathsep + ENV.get("PATH", "")

# 版本号唯一来源：构建时同步写入 version.json。
# CI 构建时用环境变量覆盖（CHARGE_VERSION_CODE / CHARGE_VERSION_NAME 来自 tag）
CHANGELOG = [
    "刷新进度：顶部卡片细进度线 + 副标题阶段文案，不再推挤下方内容",
    "抓取与端口阶段合并为一条连续进度（0-45-95%），不再闪没",
    "令牌保存/数据上传后立即刷新顶部健康状态（含 overview 缓存主动失效）",
]
VERSION_CODE = os.environ.get("CHARGE_VERSION_CODE", "215")
VERSION_NAME = os.environ.get("CHARGE_VERSION_NAME", "1.11.39")



def run(cmd):
    subprocess.run([str(c) for c in cmd], check=True, env=ENV)


def main():
    args = set(sys.argv[1:])
    unknown = args - {"--no-version-json", "--allow-stale-web"}
    if unknown:
        raise SystemExit(f"未知参数: {sorted(unknown)}")
    no_version_json = "--no-version-json" in args
    allow_stale_web = "--allow-stale-web" in args
    # 同步最新 Web 产物到 assets，并清掉旧 hash 文件，避免 APK 膨胀
    web_dist = ROOT.parent / "webui" / "dist"
    www = SRC / "assets" / "www"
    if not (web_dist / "app.html").is_file() or not (web_dist / "assets").is_dir():
        raise SystemExit(f"缺少 Web 产物（{web_dist}）：请先在 webui 执行 vite build")
    # 新鲜度校验：webui/src 明显新于 dist 时拒绝打包旧 UI（--allow-stale-web 可跳过）
    webui_src = ROOT.parent / "webui" / "src"
    if not allow_stale_web and webui_src.is_dir():
        src_newest = max((p.stat().st_mtime for p in webui_src.rglob("*") if p.is_file()),
                         default=0.0)
        dist_mtime = (web_dist / "app.html").stat().st_mtime
        if src_newest > dist_mtime + 60:
            raise SystemExit(
                "webui/src 比 webui/dist 新（疑似未 vite build）：先构建前端，"
                "或加 --allow-stale-web 仅做本地验证")
    if BUILD.exists():
        shutil.rmtree(BUILD)
    classes = BUILD / "classes"; classes.mkdir(parents=True)
    dex_dir = BUILD / "dex"; dex_dir.mkdir()
    gen = BUILD / "gen"; gen.mkdir()
    res = BUILD / "res"; res.mkdir()
    shutil.rmtree(www / "assets", ignore_errors=True)
    for name in ("index.html", "app.html", "admin.html"):
        src = web_dist / name
        if src.exists():
            shutil.copy2(src, www / name)
    shutil.copytree(web_dist / "assets", www / "assets", dirs_exist_ok=True)
    # app.html 引用的 hash 资源必须都在，避免打出白屏包
    html = (www / "app.html").read_text(encoding="utf-8")
    missing = [name for name in re.findall(r"assets/([A-Za-z0-9_.\-]+)", html)
               if not (www / "assets" / name).is_file()]
    if missing:
        raise SystemExit(f"app.html 引用的资源缺失: {missing[:5]}")
    run([AAPT2, "compile", "--dir", SRC / "res", "-o", res])
    run([AAPT2, "link", "-o", BUILD / "base.apk", "-I", PLATFORM,
         "--manifest", SRC / "AndroidManifest.xml", "--java", gen,
         "-A", SRC / "assets", "--min-sdk-version", "26",
         "--target-sdk-version", "34", "--version-code", VERSION_CODE,
         "--version-name", VERSION_NAME, *sorted(res.glob("*.flat"))])
    java = sorted((SRC / "java").rglob("*.java")) + sorted(gen.rglob("*.java"))
    run([JAVAC, "--release", "8", "-encoding", "UTF-8",
         "-classpath", PLATFORM, "-d", classes, *java])
    run([D8, "--lib", PLATFORM, "--min-api", "26",
         "--output", dex_dir, *sorted(classes.rglob("*.class"))])
    unsigned = BUILD / "unsigned.apk"
    with zipfile.ZipFile(BUILD / "base.apk") as src, \
            zipfile.ZipFile(unsigned, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            dst.writestr(item, src.read(item.filename))
        dex_files = sorted(dex_dir.glob("classes*.dex"))
        if not dex_files:
            raise SystemExit("d8 未产出 classes*.dex")
        for dex in dex_files:
            dst.write(dex, dex.name)
    run([ZIPALIGN, "-f", "4", unsigned, BUILD / "aligned.apk"])
    secrets = Path(os.environ.get("CHARGE_SECRETS_DIR", str(Path.home() / ".charge-secrets")))
    props = secrets / "keystore.properties"
    if not props.exists():
        raise SystemExit(f"缺少签名配置: {props}（需要 storeFile/storePassword/keyAlias）")
    cfg = {}
    for line in props.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip()
    keystore = Path(cfg["storeFile"])
    if not keystore.is_absolute():
        keystore = secrets / keystore
    alias = cfg.get("keyAlias", "release")
    pw = cfg["storePassword"]
    if not keystore.exists():
        raise SystemExit(f"签名文件不存在: {keystore}")
    apk = BUILD / "app-debug.apk"
    run([APKSIGNER, "sign", "--ks", keystore, "--ks-pass", f"pass:{pw}",
         "--key-pass", f"pass:{pw}", "--ks-key-alias", alias,
         "--out", apk, BUILD / "aligned.apk"])
    print("APK:", apk, apk.stat().st_size // 1024, "KB")
    digest = hashlib.sha256(apk.read_bytes()).hexdigest()
    print("SHA256:", digest)
    if no_version_json:
        print("跳过 version_clean.json（--no-version-json，仅本地验证）")
        return
    vj = ROOT.parent / "cloud" / "data" / "version_clean.json"
    try:
        data = json.loads(vj.read_text(encoding="utf-8")) if vj.exists() else {}
        data.update({
            "versionCode": int(VERSION_CODE),
            "versionName": VERSION_NAME,
            "apkPath": f"/download/app-v{VERSION_NAME}.apk?v={VERSION_CODE}",
            "sizeText": f"{apk.stat().st_size // 1024} KB",
            "sha256": digest,
            "releasedAt": time.strftime("%Y-%m-%d %H:%M"),
            "changelog": CHANGELOG,
        })
        vj.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        # 回读校验：发布元数据必须与本次构建一致
        check = json.loads(vj.read_text(encoding="utf-8"))
        if (str(check.get("versionCode")) != str(VERSION_CODE)
                or check.get("versionName") != VERSION_NAME
                or check.get("sha256") != digest):
            raise RuntimeError("version_clean 回读校验失败")
        print("version.json:", vj)
    except Exception as exc:
        raise SystemExit(f"写 version.json 失败: {exc}")


if __name__ == "__main__":
    main()
