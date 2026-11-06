import sqlite3

c = sqlite3.connect("/var/lib/charge-cloud/charge.db")
print("devices:", c.execute("SELECT COUNT(*) FROM devices").fetchone()[0])
for r in c.execute("SELECT device_id, model, app_version, created_at, last_seen, uploads, revoked FROM devices ORDER BY created_at DESC LIMIT 5"):
    print(r)
print("audit:")
for r in c.execute("SELECT id, ts, ip, size, result, detail FROM upload_audit ORDER BY id DESC LIMIT 8"):
    print(r)
print("snapshots:", c.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0])
c.close()
