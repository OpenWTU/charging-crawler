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
# 版本探测：优先 34.0.0 / android-34，找不到就用目录里最新的。
# （CI 的 ubuntu runner 预装版本不一定是 34 —— ci.yml 的 android job 就因此找不到 aapt2）
def _pick_dir(root: Path, preferred: str) -> Path:
    if (root / preferred).is_dir():
        return root / preferred
    if root.is_dir():
        cands = sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: p.name, reverse=True)
        if cands:
            print(f"[build] 未找到 {root.name}/{preferred}，改用 {cands[0].name}")
            return cands[0]
    return root / preferred


BT = _pick_dir(SDK / "build-tools", "34.0.0")
_PLATFORM_DIR = _pick_dir(SDK / "platforms", "android-34")
PLATFORM = _PLATFORM_DIR / "android.jar"
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
VERSION_NAME = os.environ.get("CHARGE_VERSION_NAME", "1.11.39")


def derive_version_code(name: str) -> str:
    """与 CI 完全相同的公式：vX.Y.Z -> X*1_000_000 + Y*1_000 + Z。

    曾经这里写死 "215"，而 CI 按 tag 派生（v1.11.39 -> 1011039）：
    同一个 versionName 会发行出两个相差 5000 倍的 versionCode，
    装了 CI 包的设备之后再也装不上本地包（系统判为降级），只能卸载重装（丢令牌/丢设置）。
    """
    m = re.match(r"^v?(\d+)\.(\d+)\.(\d+)$", name.strip())
    if not m:
        raise SystemExit(f"VERSION_NAME 格式非法（应为 X.Y.Z）：{name!r}")
    return str(int(m.group(1)) * 1_000_000 + int(m.group(2)) * 1_000 + int(m.group(3)))


# 先打印实际入参（CI 排查用；v2.4.0 的失败就是缺少这层可见性）
print(f"[build] VERSION_NAME={VERSION_NAME!r} CHARGE_VERSION_CODE={os.environ.get('CHARGE_VERSION_CODE')!r}")

_derived = derive_version_code(VERSION_NAME)
VERSION_CODE = (os.environ.get("CHARGE_VERSION_CODE") or _derived).strip()
# 防漂移：外部传入的 versionCode 与 name 派生值不一致时**只警告不中止**。
# （v2.4.0/v2.4.1 的 CI 曾因这里 raise 而整个构建失败 —— 版本号不一致是问题，
#  但用"构建失败"来表达它代价太大；让它继续构建并留下显眼日志更合适。）
if VERSION_CODE != _derived:
    print(
        f"[build][WARN] versionCode 与 versionName 不一致：{VERSION_CODE} != {_derived}"
        f"（{VERSION_NAME}）—— 已按 {VERSION_CODE} 继续构建，请检查 CI 传参"
    )



def run(cmd):
    # 与 v2.3.8 完全一致：check=True、stdout/stderr 直接继承到 CI 日志。
    # （v2.4.2 试过 capture_output=True + 自己打印，但 CI 仍在同一位置失败，
    #   先回到已知可工作的行为，把可观测性交给 workflow 的 set -x）
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
    # CI 里 checkout 的 mtime 与构建产物非常接近，这个启发式会误判（v2.4.0 的 release-apk
    # 和 ci 的 android job 都因此失败）。CI 的步骤顺序是明确的（先 vite build 再 build.py），
    # 所以只在本地启用该检查。
    in_ci = bool(os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS"))
    if not allow_stale_web and not in_ci and webui_src.is_dir():
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
    # M9 的回归修复：assets/www 已从 git 取消跟踪（.gitignore），
    # CI checkout 后这个目录**不存在** —— 原来直接 copy2 会 FileNotFoundError。
    # （v2.4.0–v2.4.3 的 CI APK 全部失败就是这个原因，我一直在猜版本号/run()）
    www.mkdir(parents=True, exist_ok=True)
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
