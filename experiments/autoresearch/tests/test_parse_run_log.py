import tempfile
import textwrap
import unittest
from pathlib import Path

from parse_run_log import parse_run_log


class ParseRunLogTests(unittest.TestCase):
    def test_extracts_summary_metrics(self):
        sample = textwrap.dedent(
            """\
            step 00001
            ---
            val_bpb:          1.234567
            training_seconds: 60.0
            total_seconds:    65.2
            peak_vram_mb:     0.0
            mfu_percent:      0.05
            total_tokens_M:   1.2
            num_steps:        7
            num_params_M:     11.5
            depth:            4
            """
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "run.log"
            path.write_text(sample)
            metrics = parse_run_log(path)
        self.assertEqual(
            metrics,
            {
                "val_bpb": 1.234567,
                "training_seconds": 60.0,
                "total_seconds": 65.2,
                "peak_vram_mb": 0.0,
                "mfu_percent": 0.05,
                "total_tokens_M": 1.2,
                "num_steps": 7,
                "num_params_M": 11.5,
                "depth": 4,
            },
        )


if __name__ == "__main__":
    unittest.main()
