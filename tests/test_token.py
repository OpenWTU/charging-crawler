"""parse_jwt 健壮性测试：任何畸形输入都只能返回 None，不能抛异常。"""

from __future__ import annotations

import base64
import json
import time
import unittest

from crawler.token import parse_jwt


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def payload_jwt(payload, header: bytes = b'{"alg":"HS256"}') -> str:
    return _b64(header) + "." + _b64(json.dumps(payload).encode()) + ".sig"


class ParseJwtTest(unittest.TestCase):
    def test_malformed_strings(self) -> None:
        for bad in ("", "abc", "a.b", "a.b.c.d", "..", "eyJ.eyJ.sig.extra"):
            self.assertIsNone(parse_jwt(bad), bad)

    def test_payload_not_object(self) -> None:
        self.assertIsNone(parse_jwt(_b64(b"{}") + "." + _b64(b"[1,2]") + ".sig"))

    def test_missing_or_bad_claims(self) -> None:
        base = {"role": "user", "encryId": base64.b64encode(b"1").decode(),
                "iss": "x", "aud": "quick_user_api", "iat": 1, "exp": 2}
        for mutate in (
            {"aud": "other"}, {"iat": None}, {"exp": None}, {"iat": "abc"},
            {"encryId": "!!"}, {"encryId": None},
        ):
            payload = dict(base)
            payload.update(mutate)
            self.assertIsNone(parse_jwt(payload_jwt(payload)), mutate)

    def test_valid_token(self) -> None:
        now = int(time.time())
        token = payload_jwt({
            "role": "user", "encryId": base64.b64encode(b"12345678").decode(),
            "iss": "quick_user_001", "iat": now, "aud": "quick_user_api",
            "exp": now + 3600, "nbf": now,
        })
        parsed = parse_jwt(token)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.user_id, "12345678")
        self.assertEqual(parsed.expires_at, now + 3600)
        self.assertFalse(parsed.expired)


if __name__ == "__main__":
    unittest.main()
