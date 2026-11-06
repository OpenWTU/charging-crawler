"""签名算法对拍测试：向量由 JS 版实现（tools/sig-vector.cjs）生成。"""

import unittest

from crawler.sign import compute_signature, join_by_length_desc


class SignTest(unittest.TestCase):
    def test_join_sorts_by_length_and_swaps_second_with_last(self):
        self.assertEqual(
            join_by_length_desc(["/nearArea/abc?isNearBy=Y", "12345678", "T", "",
                                 "179343954", "abcdefghijklmnop"]),
            "/nearArea/abc?isNearBy=Y" "179343954" "12345678" "T" "abcdefghijklmnop",
        )

    def test_signature_matches_js_vector(self):
        digest = compute_signature(
            "/nearArea/abc?isNearBy=Y", "12345678", "T", "", "179343954", "abcdefghijklmnop"
        )
        self.assertEqual(digest, "f65994493a52a5e9f8d83345b27056c7")


if __name__ == "__main__":
    unittest.main()
