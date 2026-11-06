"""``/api/*`` 路由入口：GET 分发 + mixin 组合。

各资源族的实现分别在 :mod:`api_upload`（上传/刷新/注册）、
:mod:`api_ports`（控制器与端口）、:mod:`api_state`（实时状态）、
:mod:`api_analytics`（历史与分析）；本模块只做分发。
"""

from __future__ import annotations

from .api_analytics import ApiAnalyticsMixin
from .api_ports import ApiPortsMixin
from .api_state import ApiStateMixin
from .api_upload import ApiUploadMixin


class ApiMixin(ApiUploadMixin, ApiPortsMixin, ApiStateMixin,
               ApiAnalyticsMixin):
    """GET 分发 + 组合各资源 mixin。"""

    def _api_get(self, parsed) -> bool:
        """GET 路由分发：各 ``_route_*`` 命中即返回 True，未命中交回门面 404。"""
        ip = self._client_ip()
        path = parsed.path
        if path == "/api/controllers":
            return self._route_controllers(parsed, ip)
        if path == "/api/area-coords":
            return self._route_area_coords(parsed, ip)
        if path == "/api/areas-ports":
            return self._route_areas_ports(parsed, ip)
        if path == "/api/area-ports":
            return self._route_area_ports(parsed, ip)
        if path == "/api/now":
            return self._route_now(parsed, ip)
        if path == "/api/overview":
            return self._route_overview(parsed, ip)
        if path == "/api/free-rate":
            return self._route_free_rate(parsed, ip)
        if path.startswith("/api/pile/"):
            return self._route_pile(parsed, ip)
        if path == "/api/history":
            return self._route_history(parsed, ip)
        if path == "/api/analytics":
            return self._route_analytics(parsed, ip)
        if path == "/health":
            return self._route_health(parsed, ip)
        if path == "/api/version":
            return self._route_version(parsed, ip)
        if path == "/api/latest":
            return self._route_latest(parsed, ip)
        return False
