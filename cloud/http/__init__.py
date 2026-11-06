"""HTTP 层：按职责拆分的 Handler mixin（base / api / admin / static）。

依赖方向固定为 http → 领域模块 → config/db，本包不反向被领域模块导入。
"""
